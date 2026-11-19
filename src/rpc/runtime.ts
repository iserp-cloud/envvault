import type { KdfParams, SealedBox } from "@envvault/shared";
import { DEFAULT_KDF, normalizeSlug, personalTenantId, validateKdf } from "@envvault/shared";
import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import {
  DUMMY_HASH,
  DUMMY_SALT,
  constantTimeEquals,
  hashAuthKey,
  hashInviteToken,
  newAuthSalt,
  pseudoIndex,
  verifyAuthKey,
} from "../auth-proof.js";
import { expectedSetupToken } from "../setup-token.js";
import type { Database as DbSchema, InviteRow, UserRow } from "../db/schema.js";
import {
  claimInvite,
  countUsers,
  createSession,
  createTenant,
  deleteSessionsForUser,
  deleteSettings,
  getInviteByTokenHash,
  getTenant,
  getUser,
  getUserBySessionToken,
  insertUser,
  isHandleTaken,
  listDistinctKdfs,
  listEnvironmentKeysForUser,
  markRotationPending,
  removeTenantMember,
  updateUser,
  upsertTenantMember,
} from "../db/store.js";
import { newSessionToken } from "../session-token.js";
import { signupMode } from "../security.js";

/** Authenticated caller. */
export type Auth = {
  username: string;
  role: "admin" | "member";
  kind: "user" | "service";
  /** SHA-256 of this request's session token (to tell "this device" apart). */
  sessionHash?: string;
};

export type RequestMeta = { ip: string; userAgent: string };


export type AuthSessionResult = {
  sessionToken: string;
  username: string;
  publicKey: string;
  /** Sealed client-side; the server cannot open it. */
  wrappedPrivateKey: SealedBox;
  personalTenantId: string;
  role: "admin" | "member";
};

export type RecoveryInput = {
  /** Client-derived proof of the recovery key (never the key itself). */
  authKey: string;
  wrappedPrivateKey: SealedBox;
};

export type SignupInput = {
  username: string;
  authKey: string;
  kdf: unknown;
  publicKey: string;
  wrappedPrivateKey: SealedBox;
  recovery: RecoveryInput;
  inviteToken?: string;
};

export function normalizeUsername(raw: string): string {
  return normalizeSlug(raw, "Username");
}

export async function isVaultInitialized(db: Kysely<DbSchema>): Promise<boolean> {
  return (await countUsers(db)) > 0;
}

export async function ensurePersonalTenant(
  db: Kysely<DbSchema>,
  username: string,
): Promise<string> {
  const id = personalTenantId(username);
  if (!(await getTenant(db, id))) {
    await createTenant(db, {
      id,
      slug: username,
      name: "Personal",
      owner_username: username,
      kind: "personal",
      created_at: new Date().toISOString(),
    });
  }
  await upsertTenantMember(db, {
    tenant_id: id,
    username,
    role: "owner",
    status: "active",
  });
  return id;
}

function validInvite(invite: InviteRow | undefined, now: string): invite is InviteRow {
  return Boolean(invite && !invite.used_at && !invite.revoked_at && invite.expires_at > now);
}

function sessionResult(user: UserRow, sessionToken: string): AuthSessionResult {
  return {
    sessionToken,
    username: user.username,
    publicKey: user.public_key,
    wrappedPrivateKey: JSON.parse(user.wrapped_private_key) as SealedBox,
    personalTenantId: personalTenantId(user.username),
    role: user.role,
  };
}

function recoveryColumns(recovery: RecoveryInput) {
  const salt = newAuthSalt();
  return {
    recovery_salt: salt,
    recovery_hash: hashAuthKey(recovery.authKey, salt, "recovery"),
    recovery_wrapped_private_key: JSON.stringify(recovery.wrappedPrivateKey),
  };
}

/**
 * Create an account from client-derived material. The first account becomes the
 * instance admin; later accounts follow the signup mode (invite by default).
 */
export async function registerUser(
  db: Kysely<DbSchema>,
  input: SignupInput,
  meta?: RequestMeta,
): Promise<AuthSessionResult> {
  const username = normalizeUsername(input.username);
  const kdf = validateKdf(input.kdf);

  const first = (await countUsers(db)) === 0;
  const now = new Date().toISOString();
  let invite: InviteRow | undefined;

  if (first) {
    // Fail closed: with no token configured nobody may claim the admin account
    // (the Node server generates one at startup; on Workers set ENVVAULT_SETUP_TOKEN).
    const setupToken = await expectedSetupToken(db);
    if (!setupToken) {
      throw new Error(
        "This server has no setup token configured, so the first account can't be created. Set ENVVAULT_SETUP_TOKEN.",
      );
    }
    if (!constantTimeEquals(input.inviteToken ?? "", setupToken)) {
      throw new Error("A valid setup token is required to create the first account");
    }
  } else {
    const mode = signupMode();
    if (mode === "closed") throw new Error("Sign up is disabled");
    if (mode === "invite" && !input.inviteToken) {
      throw new Error("An invite is required to sign up");
    }
    if (input.inviteToken) {
      invite = await getInviteByTokenHash(db, hashInviteToken(input.inviteToken));
      if (!validInvite(invite, now)) throw new Error("Invalid or expired invite");
    }
  }

  if (await isHandleTaken(db, username)) throw new Error("Username already taken");

  const authSalt = newAuthSalt();
  const sessionToken = newSessionToken();
  const row: UserRow = {
    username,
    kind: "user",
    auth_salt: authSalt,
    auth_hash: hashAuthKey(input.authKey, authSalt),
    kdf: JSON.stringify(kdf),
    public_key: input.publicKey,
    wrapped_private_key: JSON.stringify(input.wrappedPrivateKey),
    ...recoveryColumns(input.recovery),
    role: first ? "admin" : "member",
    status: "active",
    service_tenant: null,
    created_by: null,
    created_at: now,
  };

  await db.transaction().execute(async (trx) => {
    if (first) {
      // Two simultaneous first signups: only one may claim the admin slot.
      const claimed = await trx
        .insertInto("settings")
        .values({ key: "admin_claimed", value: username })
        .onConflict((oc) => oc.column("key").doNothing())
        .executeTakeFirst();
      if (Number(claimed.numInsertedOrUpdatedRows ?? 0) === 0) {
        throw new Error("Server already set up");
      }
      await deleteSettings(trx, ["setup_token"]);
    }
    if (invite && !(await claimInvite(trx, invite.id, username, now))) {
      throw new Error("Invalid or expired invite");
    }
    await insertUser(trx, row);
    await ensurePersonalTenant(trx, username);
    if (invite?.tenant_id) {
      const tenant = await getTenant(trx, invite.tenant_id);
      if (tenant && tenant.kind === "org") {
        await upsertTenantMember(trx, {
          tenant_id: tenant.id,
          username,
          role: invite.tenant_role ?? "member",
          status: "pending",
        });
      }
    }
    await createSession(trx, username, sessionToken, undefined, meta);
  });

  return sessionResult(row, sessionToken);
}

/**
 * KDF params the client must use to derive this user's keys. Unknown usernames get a
 * deterministic stand-in drawn from the parameter sets actually in use, so the answer
 * doesn't reveal whether an account exists even once users have different settings.
 */
export async function preloginParams(
  db: Kysely<DbSchema>,
  rawUsername: string,
): Promise<{ kdf: KdfParams }> {
  const name = rawUsername.trim().toLowerCase();
  const user = await getUser(db, name);
  if (user) {
    try {
      return { kdf: validateKdf(JSON.parse(user.kdf)) };
    } catch {
      return { kdf: DEFAULT_KDF };
    }
  }
  const variants = await listDistinctKdfs(db);
  if (variants.length === 0) return { kdf: DEFAULT_KDF };
  try {
    return { kdf: validateKdf(JSON.parse(variants[pseudoIndex(name, variants.length)]!)) };
  } catch {
    return { kdf: DEFAULT_KDF };
  }
}

export class AccountDisabledError extends Error {}

export async function loginUser(
  db: Kysely<DbSchema>,
  input: { username: string; authKey: string },
  meta?: RequestMeta,
): Promise<AuthSessionResult> {
  const username = input.username.trim().toLowerCase();
  const user = await getUser(db, username);
  // Always do the same work, so timing doesn't reveal whether the account exists.
  const ok = verifyAuthKey(
    input.authKey,
    user?.auth_salt ?? DUMMY_SALT,
    user?.auth_hash ?? DUMMY_HASH,
  );
  // Service accounts authenticate with tokens only, never a password.
  if (!user || !ok || user.kind !== "user") throw new Error("Invalid username or password");
  if (user.status !== "active") throw new AccountDisabledError("This account is disabled");
  await ensurePersonalTenant(db, username);
  const sessionToken = newSessionToken();
  await createSession(db, username, sessionToken, undefined, meta);
  return sessionResult(user, sessionToken);
}

export async function resolveAuth(
  db: Kysely<DbSchema>,
  bearer: string | undefined,
): Promise<Auth | null> {
  if (!bearer) return null;
  const user = await getUserBySessionToken(db, bearer);
  return user ? { username: user.username, role: user.role, kind: user.kind } : null;
}

export async function changePassword(
  db: Kysely<DbSchema>,
  input: {
    username: string;
    currentAuthKey: string;
    newAuthKey: string;
    newKdf: unknown;
    newWrappedPrivateKey: SealedBox;
  },
  meta?: RequestMeta,
): Promise<{ sessionToken: string }> {
  const kdf = validateKdf(input.newKdf);
  const user = await getUser(db, input.username);
  if (
    !user ||
    user.kind !== "user" ||
    !verifyAuthKey(input.currentAuthKey, user.auth_salt, user.auth_hash)
  ) {
    throw new Error("Invalid current password");
  }

  const salt = newAuthSalt();
  await updateUser(db, user.username, {
    auth_salt: salt,
    auth_hash: hashAuthKey(input.newAuthKey, salt),
    kdf: JSON.stringify(kdf),
    wrapped_private_key: JSON.stringify(input.newWrappedPrivateKey),
  });

  // Kick every device; hand the caller a fresh session.
  await deleteSessionsForUser(db, user.username);
  const sessionToken = newSessionToken();
  await createSession(db, user.username, sessionToken, undefined, meta);
  return { sessionToken };
}

// ── recovery ───────────────────────────────────────────────────────────────

async function verifiedRecoveryUser(
  db: Kysely<DbSchema>,
  username: string,
  recoveryAuthKey: string,
): Promise<UserRow> {
  const user = await getUser(db, username.trim().toLowerCase());
  const ok = verifyAuthKey(
    recoveryAuthKey,
    user?.recovery_salt || DUMMY_SALT,
    user?.recovery_hash || DUMMY_HASH,
    "recovery",
  );
  if (!user || user.kind !== "user" || !user.recovery_hash || !ok) {
    throw new Error("Invalid username or recovery key");
  }
  if (user.status !== "active") throw new AccountDisabledError("This account is disabled");
  return user;
}

/** Step 1 of recovery: after proving the recovery key, return what the client needs to unseal. */
export async function recoveryBundle(
  db: Kysely<DbSchema>,
  input: { username: string; recoveryAuthKey: string },
): Promise<{ publicKey: string; recoveryWrappedPrivateKey: SealedBox }> {
  const user = await verifiedRecoveryUser(db, input.username, input.recoveryAuthKey);
  return {
    publicKey: user.public_key,
    recoveryWrappedPrivateKey: JSON.parse(user.recovery_wrapped_private_key) as SealedBox,
  };
}

/** Step 2: set a new password (the client re-sealed the private key with it). */
export async function recoverAccount(
  db: Kysely<DbSchema>,
  input: {
    username: string;
    recoveryAuthKey: string;
    newAuthKey: string;
    newKdf: unknown;
    newWrappedPrivateKey: SealedBox;
  },
  meta?: RequestMeta,
): Promise<AuthSessionResult> {
  const kdf = validateKdf(input.newKdf);
  const user = await verifiedRecoveryUser(db, input.username, input.recoveryAuthKey);

  const salt = newAuthSalt();
  const updated: UserRow = {
    ...user,
    auth_salt: salt,
    auth_hash: hashAuthKey(input.newAuthKey, salt),
    kdf: JSON.stringify(kdf),
    wrapped_private_key: JSON.stringify(input.newWrappedPrivateKey),
  };
  await updateUser(db, user.username, {
    auth_salt: updated.auth_salt,
    auth_hash: updated.auth_hash,
    kdf: updated.kdf,
    wrapped_private_key: updated.wrapped_private_key,
  });
  await deleteSessionsForUser(db, user.username);
  const sessionToken = newSessionToken();
  await createSession(db, user.username, sessionToken, undefined, meta);
  return sessionResult(updated, sessionToken);
}

/** Replace the recovery key (e.g. after using it, or if it may be exposed). */
/**
 * Replace the recovery key. This needs the current password's proof, like changing the password:
 * a stolen session alone must not be able to swap the recovery key and then use it to take over
 * the account.
 */
export async function setRecovery(
  db: Kysely<DbSchema>,
  username: string,
  input: RecoveryInput & { currentAuthKey: string },
): Promise<void> {
  const user = await getUser(db, username);
  if (!user || user.kind !== "user" || !verifyAuthKey(input.currentAuthKey, user.auth_salt, user.auth_hash)) {
    throw new Error("Invalid current password");
  }
  await updateUser(db, username, recoveryColumns(input));
}

// ── service accounts ───────────────────────────────────────────────────────

/** Create a machine account in a workspace plus its (expiring) bearer token. */
export async function createServiceAccount(
  db: Kysely<DbSchema>,
  input: {
    name: string;
    tenantId: string;
    publicKey: string;
    createdBy: string;
    expiresAt: string;
  },
): Promise<{ username: string; token: string }> {
  const username = normalizeUsername(`svc-${input.name}`);
  if (await isHandleTaken(db, username)) throw new Error("Username already taken");

  const salt = newAuthSalt();
  const token = newSessionToken();
  const row: UserRow = {
    username,
    kind: "service",
    auth_salt: salt,
    // Random, never revealed: there is no password to derive a matching proof from.
    auth_hash: hashAuthKey(randomBytes(32).toString("base64url"), salt),
    kdf: JSON.stringify(DEFAULT_KDF),
    public_key: input.publicKey,
    wrapped_private_key: "",
    recovery_salt: "",
    recovery_hash: "",
    recovery_wrapped_private_key: "",
    role: "member",
    status: "active",
    service_tenant: input.tenantId,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
  };
  await db.transaction().execute(async (trx) => {
    await insertUser(trx, row);
    await upsertTenantMember(trx, {
      tenant_id: input.tenantId,
      username,
      role: "member",
      status: "active",
    });
    await createSession(trx, username, token, input.expiresAt);
  });
  return { username, token };
}

/**
 * Revoke a service account: kill its tokens, disable it, strip its keys and ACLs.
 * Returns the environments it could read — the caller must rotate them, since the
 * token holder still knows those DEKs.
 */
export async function revokeServiceAccount(
  db: Kysely<DbSchema>,
  tenantId: string,
  username: string,
): Promise<Array<{ project: string; env: string }>> {
  const user = await getUser(db, username);
  if (!user || user.kind !== "service" || user.service_tenant !== tenantId) {
    throw new Error("Service account not found");
  }
  const affected = await listEnvironmentKeysForUser(db, tenantId, username);
  await markRotationPending(db, tenantId, affected);
  await updateUser(db, username, { status: "disabled" });
  await deleteSessionsForUser(db, username);
  await removeTenantMember(db, tenantId, username);
  return affected;
}
