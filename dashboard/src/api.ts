import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  DEFAULT_KDF,
  checkPin,
  createAccountMaterial,
  createRecoveryMaterial,
  deriveFromPassword,
  deriveRecoveryKeys,
  derivePublicKey,
  encodeServiceToken,
  envAad,
  fitHistory,
  formatFingerprint,
  generateDek,
  generateIdentityKeyPair,
  keyFingerprintHex,
  cleanLabels,
  noGroups,
  openEnvData,
  pruneGroups,
  type EnvData,
  openPrivateKey,
  openRecoveredPrivateKey,
  privateKeyAad,
  publicKeyFingerprint,
  seal,
  sealEnvData,
  unwrapSecretWithPrivateKey,
  wrapSecretForPublicKey,
  hasCap,
  type AclCap,
  type KdfParams,
  type PinCheck,
  type SealedBox,
  validateNewPassword,
} from "@envvault/shared";

/**
 * All cryptography happens here, in the browser. The server only ever receives
 * a login proof (never the password), public keys, wrapped keys, and ciphertext.
 */

export type Role = "admin" | "member";

export type Session = {
  token: string;
  username: string;
  publicKey: string;
  /** Decrypted identity private key — memory only, never persisted (see StoredSession). */
  privateKey: string;
  personalTenantId: string;
  activeTenantId: string;
  /** Instance role: admins manage users and invites. */
  role: Role;
};

export type TenantMeta = {
  id: string;
  slug: string;
  name: string;
  ownerUsername: string;
  createdAt: string;
  role: "owner" | "admin" | "member";
  kind: "personal" | "org";
};

export type ProjectMeta = {
  name: string;
  tenantId: string;
  updatedAt: string;
  level: "read" | "write" | "manage";
  canManage?: boolean;
};

export type EnvMeta = {
  name: string;
  updatedAt: string;
  level: "read" | "write" | "manage";
  /** Extra permissions (comma list: delete, share, rotate); a manager has all of them. */
  caps: string;
  wrappedEnvDek: string;
  /** Which key generation `wrappedEnvDek` belongs to; a grant must carry it back. */
  keyVersion: number;
  /** A member who knew this key was removed and it hasn't been rotated yet. */
  rotatePending?: boolean;
  /** Unwrapped in memory after list */
  envDek?: string;
};

export type EnvVersionMeta = {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  note: string;
};

export type EnvHistory = {
  current: { version: number; updatedAt: string; updatedBy: string; note: string };
  /** Earlier versions, newest first. */
  history: EnvVersionMeta[];
};

export type ProjectEnv = {
  name: string;
  tenantId: string;
  projectName: string;
  updatedAt: string;
  env: Record<string, string>;
  /** Group of each key that is not in the default group. */
  groups: Record<string, string>;
  /** The environment's registry of group names. */
  labels: string[];
};

export type TenantInvite = {
  id: string;
  slug?: string;
  name: string;
  ownerUsername: string;
  createdAt: string;
  role: "owner" | "admin" | "member";
  kind?: "personal" | "org";
};

export type TenantMember = {
  username: string;
  role: "owner" | "admin" | "member";
  status: "pending" | "active";
};

export type SignupMode = "open" | "invite" | "closed";

export type AdminUser = {
  username: string;
  kind: "user" | "service";
  role: Role;
  status: "active" | "disabled";
  createdAt: string;
};

export type AdminInvite = {
  id: string;
  note: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  tenantId: string | null;
  tenantRole: "admin" | "member" | null;
  usedBy: string | null;
  usedAt: string | null;
  state: "active" | "used" | "revoked" | "expired";
};

export type AuditEvent = {
  id: string;
  at: string;
  actor: string;
  action: string;
  tenantId: string | null;
  target: string;
  detail: string;
  ip: string;
};

export type SessionInfo = {
  id: string;
  createdAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
  current: boolean;
};

export type ServiceAccount = {
  username: string;
  createdBy: string | null;
  createdAt: string;
  status: "active" | "disabled";
  expiresAt: string | null;
};

type Level = "read" | "write" | "manage";
/** Who has access, with each grant's effective permissions. */
export type AccessEntry = { username: string; level: Level; caps: AclCap[] };
type KeyWrap = { username: string; wrappedEnvDek: string };
type EnvLocation = { tenantId: string; project: string; name: string };

type AuthResult = {
  ok: true;
  token: string;
  username: string;
  publicKey: string;
  wrappedPrivateKey: SealedBox;
  personalTenantId: string;
  role: Role;
};

type DashboardClient = {
  status: () => Promise<{
    initialized: boolean;
    signupMode: SignupMode;
    requiresSetupToken: boolean;
  }>;
  prelogin: (input: { username: string }) => Promise<{ kdf: KdfParams }>;
  signup: (input: {
    username: string;
    authKey: string;
    kdf: KdfParams;
    publicKey: string;
    wrappedPrivateKey: SealedBox;
    recovery: { authKey: string; wrappedPrivateKey: SealedBox };
    inviteToken?: string;
  }) => Promise<AuthResult>;
  sessions: {
    list: () => Promise<SessionInfo[]>;
    revoke: (input: { id: string }) => Promise<{ ok: true }>;
    revokeOthers: () => Promise<{ ok: true }>;
  };
  recovery: {
    bundle: (input: { username: string; recoveryAuthKey: string }) => Promise<{
      publicKey: string;
      recoveryWrappedPrivateKey: SealedBox;
    }>;
    recover: (input: {
      username: string;
      recoveryAuthKey: string;
      newAuthKey: string;
      newKdf: KdfParams;
      newWrappedPrivateKey: SealedBox;
    }) => Promise<AuthResult>;
    set: (input: {
      currentAuthKey: string;
      authKey: string;
      wrappedPrivateKey: SealedBox;
    }) => Promise<{ ok: true }>;
  };
  k8s: {
    clusters: {
      list: (input: { tenantId: string }) => Promise<K8sCluster[]>;
      extend: (input: { tenantId: string; cluster: string; expiresInDays?: number }) => Promise<{ expiresAt: string }>;
      links: (input: { tenantId: string; cluster: string }) => Promise<K8sLink[]>;
      replace: (input: { tenantId: string; from: string; to: string }) => Promise<{ moved: number }>;
    };
    links: {
      list: (input: { tenantId: string; project: string; name: string }) => Promise<K8sLink[]>;
      create: (input: {
        tenantId: string;
        project: string;
        name: string;
        cluster: string;
        namespace: string;
        secretName: string;
        direction: "pull" | "push";
        adopt?: boolean;
        group?: string;
        kind?: "Secret" | "ConfigMap";
      }) => Promise<K8sLink>;
      adopt: (input: { tenantId: string; id: string; adopt: boolean }) => Promise<K8sLink>;
      delete: (input: { tenantId: string; id: string }) => Promise<{ ok: true; revoked: boolean }>;
    };
  };
  serviceAccounts: {
    create: (input: {
      tenantId: string;
      name: string;
      publicKey: string;
      expiresInDays?: number;
    }) => Promise<{ username: string; token: string; expiresAt: string }>;
    list: (input: { tenantId: string }) => Promise<ServiceAccount[]>;
    revoke: (input: { tenantId: string; username: string }) => Promise<{
      ok: true;
      rotate: { project: string; env: string }[];
    }>;
  };
  login: (input: { username: string; authKey: string }) => Promise<AuthResult>;
  changePassword: (input: {
    currentAuthKey: string;
    newAuthKey: string;
    newKdf: KdfParams;
    newWrappedPrivateKey: SealedBox;
  }) => Promise<{ ok: true; sessionToken: string }>;
  users: {
    resolve: (input: { username: string }) => Promise<{ username: string; publicKey: string }>;
  };
  admin: {
    audit: {
      list: (input: { limit?: number; before?: string; actor?: string; tenantId?: string }) => Promise<AuditEvent[]>;
      verify: () => Promise<{ checked: number; invalid: number; unsigned: number }>;
    };
    users: {
      list: () => Promise<AdminUser[]>;
      setStatus: (input: { username: string; status: "active" | "disabled" }) => Promise<{ ok: true }>;
      setRole: (input: { username: string; role: Role }) => Promise<{ ok: true }>;
    };
    invites: {
      create: (input: {
        expiresInHours?: number;
        note?: string;
        tenantId?: string;
        tenantRole?: "admin" | "member";
      }) => Promise<{ id: string; token: string; expiresAt: string }>;
      list: () => Promise<AdminInvite[]>;
      revoke: (input: { id: string }) => Promise<{ ok: true }>;
    };
  };
  tenants: {
    list: () => Promise<TenantMeta[]>;
    create: (input: { name: string }) => Promise<{
      id: string;
      slug: string;
      name: string;
      ownerUsername: string;
      createdAt: string;
      kind: "org";
    }>;
    members: (input: { tenantId: string }) => Promise<TenantMember[]>;
    invite: (input: {
      tenantId: string;
      username: string;
      role?: "admin" | "member";
    }) => Promise<{ ok: true; username: string }>;
    invites: () => Promise<TenantInvite[]>;
    acceptInvite: (input: { tenantId: string }) => Promise<{ ok: true }>;
    declineInvite: (input: { tenantId: string }) => Promise<{ ok: true }>;
    removeMember: (input: { tenantId: string; username: string }) => Promise<{
      ok: true;
      username: string;
      wasPending: boolean;
      rotate: { project: string; env: string }[];
    }>;
    delete: (input: { tenantId: string }) => Promise<{ ok: true; id: string }>;
    keyRecipients: (input: { tenantId: string }) => Promise<{ username: string; publicKey: string }[]>;
    audit: (input: { tenantId: string; limit?: number; before?: string }) => Promise<AuditEvent[]>;
  };
  projects: {
    list: (input?: { tenantId?: string }) => Promise<ProjectMeta[]>;
    create: (input: {
      tenantId: string;
      name: string;
      payload: SealedBox;
      keyWraps: KeyWrap[];
    }) => Promise<{ name: string; tenantId: string; updatedAt: string }>;
    delete: (input: { tenantId: string; name: string }) => Promise<{ ok: true }>;
  };
  environments: {
    list: (input: { tenantId: string; project: string }) => Promise<Omit<EnvMeta, "envDek">[]>;
    create: (
      input: EnvLocation & { payload: SealedBox; keyWraps: KeyWrap[] },
    ) => Promise<{ name: string; updatedAt: string }>;
    delete: (input: EnvLocation) => Promise<{ ok: true }>;
    getEnv: (input: EnvLocation) => Promise<{
      tenantId: string;
      projectName: string;
      name: string;
      updatedAt: string;
      payload: SealedBox;
    }>;
    saveEnv: (
      input: EnvLocation & { payload: SealedBox; baseUpdatedAt?: string; note?: string },
    ) => Promise<{ name: string; updatedAt: string }>;
    rotate: (
      input: EnvLocation & {
        payload: SealedBox;
        keyWraps: KeyWrap[];
        baseUpdatedAt?: string;
        history?: Array<{ id: string; payload: SealedBox }>;
      },
    ) => Promise<{ ok: true; updatedAt: string }>;
    versions: {
      list: (input: EnvLocation) => Promise<EnvHistory>;
      get: (input: EnvLocation & { id: string }) => Promise<EnvVersionMeta & { payload: SealedBox }>;
      delete: (input: EnvLocation & { id: string }) => Promise<{ ok: true }>;
      export: (
        input: EnvLocation,
      ) => Promise<Array<{ id: string; version: number; payload: SealedBox }>>;
    };
    grantAccess: (
      input: EnvLocation & { username: string; level: Level; caps?: AclCap[]; wrappedEnvDek: string; keyVersion: number },
    ) => Promise<{ ok: true }>;
    listAccess: (input: EnvLocation) => Promise<AccessEntry[]>;
  };
};

export function resolveApiBase(): string {
  return typeof window !== "undefined"
    ? window.location.origin
    : "http://127.0.0.1:3847";
}

function createClient(session?: Session): DashboardClient {
  const link = new RPCLink({
    url: `${resolveApiBase()}/rpc`,
    headers: () => (session ? { authorization: `Bearer ${session.token.trim()}` } : {}),
  });
  return createORPCClient(link) as DashboardClient;
}

function toError(err: unknown): Error {
  if (err instanceof ORPCError) return new Error(err.message || err.code);
  if (err instanceof Error) return err;
  return new Error(String(err));
}

/** Run an API call, normalising errors to plain Error instances. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toError(err);
  }
}

/**
 * What survives a page refresh (sessionStorage: this tab only, gone when it closes).
 * Deliberately everything except the decrypted private key, which exists only in
 * memory — after a refresh the user re-enters their password to unlock it.
 */
export type StoredSession = Omit<Session, "privateKey">;

const SESSION_KEY = "envvault.session";
const UNLOCK_KEY = "envvault.unlocked";

/**
 * How long after the last activity a page refresh keeps the vault unlocked. While the window is
 * open the decrypted private key sits in this tab's sessionStorage (gone when the tab closes), so
 * script running on this page, or someone at the open browser, could read it. 0 turns it off: the
 * key then lives in memory only and every refresh asks for the password. Locking, signing out, the
 * idle lock and an expired session all wipe it at once.
 */
export const REFRESH_GRACE_MINUTES = 10;

export function saveSession(session: Session): void {
  const { privateKey, ...stored } = session;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(stored satisfies StoredSession));
    if (REFRESH_GRACE_MINUTES > 0) sessionStorage.setItem(UNLOCK_KEY, JSON.stringify({ privateKey, at: Date.now() }));
  } catch {
    /* storage unavailable: the user just signs in again after a refresh */
  }
}

/** Wipe the kept key (lock, sign-out, expiry). */
export function forgetUnlock(): void {
  try {
    sessionStorage.removeItem(UNLOCK_KEY);
  } catch {
    /* storage unavailable */
  }
}

let lastTouch = 0;
/** Note user activity so the grace window counts from the last input. Cheap: at most one write every 15 s. */
export function touchUnlock(): void {
  const now = Date.now();
  if (now - lastTouch < 15_000) return;
  lastTouch = now;
  try {
    const raw = sessionStorage.getItem(UNLOCK_KEY);
    if (!raw) return;
    const k = JSON.parse(raw) as { privateKey?: string; at?: number };
    if (typeof k.privateKey === "string") sessionStorage.setItem(UNLOCK_KEY, JSON.stringify({ privateKey: k.privateKey, at: now }));
  } catch {
    /* ignore */
  }
}

/** After a refresh: the unlocked session again if it is still inside the grace window and the key still matches. */
export async function restoreUnlocked(stored: StoredSession): Promise<Session | null> {
  if (REFRESH_GRACE_MINUTES <= 0) return null;
  try {
    const raw = sessionStorage.getItem(UNLOCK_KEY);
    if (!raw) return null;
    const k = JSON.parse(raw) as { privateKey?: string; at?: number };
    const fresh = typeof k.at === "number" && Date.now() - k.at < REFRESH_GRACE_MINUTES * 60_000;
    if (!fresh || typeof k.privateKey !== "string" || (await derivePublicKey(k.privateKey)) !== stored.publicKey) {
      forgetUnlock();
      return null;
    }
    return { ...stored, privateKey: k.privateKey };
  } catch {
    forgetUnlock();
    return null;
  }
}

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof s.token === "string" && s.token &&
      typeof s.username === "string" && s.username &&
      typeof s.publicKey === "string" &&
      typeof s.personalTenantId === "string" &&
      typeof s.activeTenantId === "string" &&
      (s.role === "admin" || s.role === "member")
    ) {
      return s as StoredSession;
    }
  } catch {
    /* corrupt or unavailable */
  }
  return null;
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(UNLOCK_KEY);
    // Older versions kept these.
    localStorage.removeItem("envvault.token");
    localStorage.removeItem("envvault.syncToken");
  } catch {
    /* storage unavailable */
  }
}
export function clearAllCredentials(): void {
  clearSession();
}

/**
 * Unlock a kept session after a refresh or lock. The password is proved to the hub exactly
 * like a normal sign-in (throttled, and nothing is handed out on a bare session token), and
 * the old session is retired in favour of the fresh one.
 */
export async function unlockStoredSession(stored: StoredSession, password: string): Promise<Session> {
  const next = await loginVault(stored.username, password);
  // Not signOut(): that also clears sessionStorage, which now holds the *new* session.
  void revokeRemoteSession(stored);
  return { ...next, activeTenantId: stored.activeTenantId };
}

/** Revoke a session on the hub (best effort). Leaves local storage alone. */
export async function revokeRemoteSession(session: Pick<Session, "token">): Promise<void> {
  try {
    const probe = { ...session, privateKey: "" } as Session;
    const mine = (await createClient(probe).sessions.list()).find((s) => s.current);
    if (mine) await createClient(probe).sessions.revoke({ id: mine.id });
  } catch {
    /* already expired or offline: nothing more to do */
  }
}

export async function fetchStatus() {
  return call(() => createClient().status());
}

/** Guard against a server that returns a public key that isn't ours. */
async function verifiedSession(
  result: Pick<AuthResult, "token" | "username" | "publicKey" | "personalTenantId" | "role">,
  privateKey: string,
  activeTenantId?: string,
): Promise<Session> {
  if ((await derivePublicKey(privateKey)) !== result.publicKey) {
    throw new Error("The server returned a public key that does not match your private key. Do not continue.");
  }
  return {
    token: result.token,
    username: result.username,
    publicKey: result.publicKey,
    privateKey,
    personalTenantId: result.personalTenantId,
    activeTenantId: activeTenantId ?? result.personalTenantId,
    role: result.role,
  };
}

/**
 * Create an account. `inviteToken` is an invite (or the first-run setup token).
 * Returns the session and the recovery key — show it once; it is not stored anywhere.
 */
export async function signupVault(
  username: string,
  password: string,
  inviteToken?: string,
): Promise<{ session: Session; recoveryKey: string }> {
  return call(async () => {
    const name = username.trim().toLowerCase();
    const m = await createAccountMaterial(name, password, DEFAULT_KDF);
    const result = await createClient().signup({
      username: name,
      authKey: m.authKey,
      kdf: m.kdf,
      publicKey: m.publicKey,
      wrappedPrivateKey: m.wrappedPrivateKey,
      recovery: {
        authKey: m.recovery.recoveryAuthKey,
        wrappedPrivateKey: m.recovery.recoveryWrappedPrivateKey,
      },
      inviteToken: inviteToken?.trim() || undefined,
    });
    return { session: await verifiedSession(result, m.privateKey), recoveryKey: m.recovery.recoveryKey };
  });
}

export async function loginVault(username: string, password: string): Promise<Session> {
  return call(async () => {
    const name = username.trim().toLowerCase();
    const { kdf } = await createClient().prelogin({ username: name });
    const keys = await deriveFromPassword(password, name, kdf);
    const result = await createClient().login({ username: name, authKey: keys.authKey });
    const privateKey = await openPrivateKey(result.wrappedPrivateKey, keys.wrapKey, name);
    return verifiedSession(result, privateKey);
  });
}

/** Forgot your password: prove the recovery key, set a new password. */
export async function recoverVault(
  username: string,
  recoveryKey: string,
  newPassword: string,
): Promise<Session> {
  return call(async () => {
    {
      const weak = validateNewPassword(newPassword);
      if (weak) throw new Error(weak);
    }
    const name = username.trim().toLowerCase();
    const api = createClient();
    const { recoveryAuthKey, recoveryWrapKey } = await deriveRecoveryKeys(recoveryKey);
    const bundle = await api.recovery.bundle({ username: name, recoveryAuthKey });
    const privateKey = await openRecoveredPrivateKey(bundle.recoveryWrappedPrivateKey, recoveryWrapKey, name);
    const next = await deriveFromPassword(newPassword, name, DEFAULT_KDF);
    const result = await api.recovery.recover({
      username: name,
      recoveryAuthKey,
      newAuthKey: next.authKey,
      newKdf: DEFAULT_KDF,
      newWrappedPrivateKey: await seal(privateKey, next.wrapKey, privateKeyAad(name)),
    });
    return verifiedSession(result, privateKey);
  });
}

/**
 * Replace your recovery key (the old one stops working). Needs your current password, so a stolen
 * session can't swap it. Returns the new key to show once.
 */
export async function regenerateRecoveryKey(session: Session, currentPassword: string): Promise<string> {
  return call(async () => {
    const api = createClient(session);
    const { kdf } = await api.prelogin({ username: session.username });
    const current = await deriveFromPassword(currentPassword, session.username, kdf);
    const m = await createRecoveryMaterial(session.username, session.privateKey);
    await api.recovery.set({
      currentAuthKey: current.authKey,
      authKey: m.recoveryAuthKey,
      wrappedPrivateKey: m.recoveryWrappedPrivateKey,
    });
    return m.recoveryKey;
  });
}

export async function changePassword(
  session: Session,
  input: { currentPassword: string; newPassword: string; confirm: string },
): Promise<Session> {
  return call(async () => {
    if (input.newPassword !== input.confirm) throw new Error("New passwords do not match");
    const weak = validateNewPassword(input.newPassword);
    if (weak) throw new Error(weak);
    const api = createClient(session);
    const { kdf } = await api.prelogin({ username: session.username });
    const current = await deriveFromPassword(input.currentPassword, session.username, kdf);
    const next = await deriveFromPassword(input.newPassword, session.username, DEFAULT_KDF);
    const result = await api.changePassword({
      currentAuthKey: current.authKey,
      newAuthKey: next.authKey,
      newKdf: DEFAULT_KDF,
      newWrappedPrivateKey: await seal(
        session.privateKey,
        next.wrapKey,
        privateKeyAad(session.username),
      ),
    });
    return { ...session, token: result.sessionToken };
  });
}

/** Fingerprint of your own public key, for out-of-band verification. */
export function myFingerprint(session: Session): Promise<string> {
  return publicKeyFingerprint(session.publicKey);
}

// ── public-key pinning (trust on first use) ────────────────────────────────
// We remember each person's key fingerprint the first time we wrap a secret for
// them. If the server later hands us a different key, we refuse until you verify.

const PIN_KEY = "envvault.pins.v1";

function loadPins(): Record<string, string> {
  try {
    const all = JSON.parse(localStorage.getItem(PIN_KEY) ?? "{}") as Record<string, Record<string, string>>;
    return all[resolveApiBase()] ?? {};
  } catch {
    return {};
  }
}

function savePin(username: string, fingerprint: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(PIN_KEY) ?? "{}") as Record<string, Record<string, string>>;
    const origin = resolveApiBase();
    all[origin] = { ...(all[origin] ?? {}), [username.toLowerCase()]: fingerprint };
    localStorage.setItem(PIN_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: pinning is best-effort */
  }
}

/** Forget every remembered key for this server (after you have verified a legitimate key change). */
export function resetKeyPins(): void {
  try {
    const all = JSON.parse(localStorage.getItem(PIN_KEY) ?? "{}") as Record<string, unknown>;
    delete all[resolveApiBase()];
    localStorage.setItem(PIN_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export type PreparedGrant = PinCheck & { publicKey: string; username: string; display: string };

/** Look up someone's key and compare it with what we've pinned. UI should confirm unless `status === "match"`. */
export async function prepareGrant(session: Session, username: string): Promise<PreparedGrant> {
  return call(async () => {
    const name = username.trim().toLowerCase();
    const { publicKey } = await createClient(session).users.resolve({ username: name });
    const fp = await keyFingerprintHex(publicKey);
    const check = checkPin(loadPins(), name, fp);
    return { ...check, publicKey, username: name, display: formatFingerprint(fp) };
  });
}

// ── tenants ────────────────────────────────────────────────────────────────

export const listTenants = (s: Session) => call(() => createClient(s).tenants.list());

export const createOrgTenant = (s: Session, name: string) =>
  call(() => createClient(s).tenants.create({ name }));

export const listTenantMembers = (s: Session, tenantId: string) =>
  call(() => createClient(s).tenants.members({ tenantId }));

export async function inviteToTenant(
  s: Session,
  tenantId: string,
  username: string,
  role?: "admin" | "member",
): Promise<void> {
  await call(() => createClient(s).tenants.invite({ tenantId, username, role }));
}

/** Rotate each listed environment (those you have the rotate permission on); report the rest. */
async function rotateAffected(
  s: Session,
  tenantId: string,
  affected: { project: string; env: string }[],
): Promise<{ rotated: number; notRotated: string[] }> {
  let rotated = 0;
  const notRotated: string[] = [];
  for (const { project, env } of affected) {
    try {
      const metas = await listEnvironments(s, project, tenantId);
      const meta = metas.find((m) => m.name === env);
      if (!meta?.envDek || !hasCap(meta.level, meta.caps, "rotate")) throw new Error("no rotate permission");
      await rotateEnvironment(s, { tenantId, project, name: env }, meta.envDek, []);
      rotated++;
    } catch {
      notRotated.push(`${project}/${env}`);
    }
  }
  return { rotated, notRotated };
}

/**
 * Remove a member, then rotate the key of every environment they could read —
 * they still know the old keys, so access is only really revoked once the data
 * is re-encrypted. Environments this user can't rotate are reported back.
 */
export async function removeTenantMember(
  s: Session,
  tenantId: string,
  username: string,
): Promise<{ wasPending: boolean; rotated: number; notRotated: string[] }> {
  const result = await call(() => createClient(s).tenants.removeMember({ tenantId, username }));
  return { wasPending: result.wasPending, ...(await rotateAffected(s, tenantId, result.rotate)) };
}

export async function deleteOrgTenant(s: Session, tenantId: string): Promise<void> {
  await call(() => createClient(s).tenants.delete({ tenantId }));
}

export const listInvites = (s: Session) => call(() => createClient(s).tenants.invites());

export async function acceptInvite(s: Session, tenantId: string): Promise<void> {
  await call(() => createClient(s).tenants.acceptInvite({ tenantId }));
}

export async function declineInvite(s: Session, tenantId: string): Promise<void> {
  await call(() => createClient(s).tenants.declineInvite({ tenantId }));
}

export const resolveUser = (s: Session, username: string) =>
  call(() => createClient(s).users.resolve({ username }));

// ── projects & environments ────────────────────────────────────────────────

export const listProjects = (s: Session) =>
  call(() => createClient(s).projects.list({ tenantId: s.activeTenantId }));

export async function listEnvironments(
  s: Session,
  project: string,
  tenantId: string = s.activeTenantId,
): Promise<EnvMeta[]> {
  const rows = await call(() => createClient(s).environments.list({ tenantId, project }));
  const unwrapped = await Promise.all(
    rows.map(async (row): Promise<EnvMeta | null> => {
      try {
        return { ...row, envDek: await unwrapSecretWithPrivateKey(row.wrappedEnvDek, s.privateKey) };
      } catch {
        return null; // can't unwrap with our key — skip
      }
    }),
  );
  return unwrapped.filter((e): e is EnvMeta => e !== null);
}

async function wrapForTenant(s: Session, dek: string, tenantId: string): Promise<KeyWrap[]> {
  const recipients = await createClient(s).tenants.keyRecipients({ tenantId });
  const pins = loadPins();
  return Promise.all(
    recipients.map(async (r) => {
      // Never trust the server's copy of our own key.
      const publicKey = r.username === s.username ? s.publicKey : r.publicKey;
      const fp = await keyFingerprintHex(publicKey);
      const check = checkPin(pins, r.username, fp);
      if (check.status === "changed") {
        throw new Error(
          `The public key for "${r.username}" has changed since you last saw it. ` +
            "This could mean their account was reset — or that the server is tampering. " +
            "Verify their key fingerprint with them, then reset trusted keys from the account menu.",
        );
      }
      if (check.status === "new") savePin(r.username, fp);
      return { username: r.username, wrappedEnvDek: await wrapSecretForPublicKey(dek, publicKey) };
    }),
  );
}

export async function createProject(
  s: Session,
  name: string,
): Promise<{ project: ProjectMeta; defaultEnv: EnvMeta }> {
  return call(async () => {
    const tenantId = s.activeTenantId;
    const dek = generateDek();
    const [keyWraps, payload] = await Promise.all([
      wrapForTenant(s, dek, tenantId),
      sealEnvData({ vars: {}, ...noGroups() }, dek, envAad(tenantId, name, "default")),
    ]);
    const created = await createClient(s).projects.create({ tenantId, name, payload, keyWraps });
    return {
      project: {
        name: created.name,
        tenantId: created.tenantId,
        updatedAt: created.updatedAt,
        level: "manage",
        canManage: true,
      },
      defaultEnv: {
        name: "default",
        updatedAt: created.updatedAt,
        level: "manage",
        caps: "",
        wrappedEnvDek: "",
        keyVersion: 1,
        envDek: dek,
      },
    };
  });
}

export async function createEnvironment(s: Session, project: string, name: string): Promise<EnvMeta> {
  return call(async () => {
    const tenantId = s.activeTenantId;
    const envName = name.trim().toLowerCase();
    const dek = generateDek();
    const [keyWraps, payload] = await Promise.all([
      wrapForTenant(s, dek, tenantId),
      sealEnvData({ vars: {}, ...noGroups() }, dek, envAad(tenantId, project, envName)),
    ]);
    const created = await createClient(s).environments.create({
      tenantId,
      project,
      name,
      payload,
      keyWraps,
    });
    return {
      name: created.name,
      updatedAt: created.updatedAt,
      level: "manage",
      caps: "",
      wrappedEnvDek: "",
      keyVersion: 1,
      envDek: dek,
    };
  });
}

export async function deleteEnvironment(s: Session, project: string, name: string): Promise<void> {
  await call(() =>
    createClient(s).environments.delete({ tenantId: s.activeTenantId, project, name }),
  );
}

export async function deleteProject(s: Session, name: string): Promise<void> {
  await call(() => createClient(s).projects.delete({ tenantId: s.activeTenantId, name }));
}

export async function getEnv(
  s: Session,
  project: string,
  envName: string,
  envDek: string,
): Promise<ProjectEnv> {
  return call(async () => {
    const tenantId = s.activeTenantId;
    const got = await createClient(s).environments.getEnv({ tenantId, project, name: envName });
    const data = await openEnvData(got.payload, envDek, envAad(tenantId, project, envName));
    return {
      name: got.name,
      tenantId: got.tenantId,
      projectName: got.projectName,
      updatedAt: got.updatedAt,
      env: data.vars,
      groups: data.groups,
      labels: data.labels,
    };
  });
}

export async function saveEnv(
  s: Session,
  project: string,
  envName: string,
  env: Record<string, string>,
  grouping: Pick<EnvData, "groups" | "labels">,
  envDek: string,
  baseUpdatedAt?: string | null,
  note?: string,
): Promise<ProjectEnv> {
  return call(async () => {
    const tenantId = s.activeTenantId;
    const payload = await sealEnvData({ vars: env, ...grouping }, envDek, envAad(tenantId, project, envName));
    const saved = await createClient(s).environments.saveEnv({
      tenantId,
      project,
      name: envName,
      payload,
      baseUpdatedAt: baseUpdatedAt ?? undefined,
      note: note || undefined,
    });
    return { name: envName, tenantId, projectName: project, updatedAt: saved.updatedAt, env, groups: pruneGroups(env, grouping.groups), labels: cleanLabels(grouping.labels) };
  });
}

export const listEnvHistory = (s: Session, project: string, envName: string) =>
  call(() =>
    createClient(s).environments.versions.list({ tenantId: s.activeTenantId, project, name: envName }),
  );

/** Fetch and decrypt one earlier version of an environment. */
export async function readEnvVersion(
  s: Session,
  project: string,
  envName: string,
  id: string,
  envDek: string,
): Promise<{ env: Record<string, string>; groups: Record<string, string>; labels: string[] }> {
  return call(async () => {
    const tenantId = s.activeTenantId;
    const v = await createClient(s).environments.versions.get({ tenantId, project, name: envName, id });
    const data = await openEnvData(v.payload, envDek, envAad(tenantId, project, envName));
    return { env: data.vars, groups: data.groups, labels: data.labels };
  });
}

export const deleteEnvVersion = (s: Session, project: string, envName: string, id: string) =>
  call(() =>
    createClient(s).environments.versions.delete({ tenantId: s.activeTenantId, project, name: envName, id }),
  );

export async function listEnvironmentAccess(
  s: Session,
  project: string,
  envName: string,
): Promise<AccessEntry[]> {
  return call(() =>
    createClient(s).environments.listAccess({
      tenantId: s.activeTenantId,
      project,
      name: envName,
    }),
  );
}

/** Grant access using a key you have already prepared (and, if new/changed, confirmed) via `prepareGrant`. */
export async function grantEnvironmentAccess(
  s: Session,
  project: string,
  envName: string,
  prepared: PreparedGrant,
  level: Level,
  envDek: string,
  keyVersion: number,
  caps: AclCap[] = [],
): Promise<void> {
  await call(async () => {
    await createClient(s).environments.grantAccess({
      tenantId: s.activeTenantId,
      project,
      name: envName,
      username: prepared.username,
      level,
      caps,
      wrappedEnvDek: await wrapSecretForPublicKey(envDek, prepared.publicKey),
      keyVersion,
    });
    savePin(prepared.username, prepared.fingerprint);
  });
}

/**
 * Re-encrypt an environment under a fresh DEK and re-wrap it for everyone who
 * should keep access (current ACL minus `exclude`). Returns the new DEK.
 */
async function rotateEnvironment(
  s: Session,
  loc: EnvLocation,
  currentDek: string,
  exclude: string[],
): Promise<{ dek: string; droppedVersions: number }> {
  const api = createClient(s);
  const current = await api.environments.getEnv(loc);
  const env = await openEnvData(current.payload, currentDek, envAad(loc.tenantId, loc.project, loc.name));

  const acl = await api.environments.listAccess(loc);
  const keep = acl.map((a) => a.username).filter((u) => !exclude.includes(u));
  const newDek = generateDek();
  const pins = loadPins();
  const keyWraps = await Promise.all(
    keep.map(async (username) => {
      const { publicKey } =
        username === s.username ? { publicKey: s.publicKey } : await api.users.resolve({ username });
      const check = checkPin(pins, username, await keyFingerprintHex(publicKey));
      if (check.status === "changed") {
        throw new Error(`The public key for "${username}" has changed — verify it before rotating.`);
      }
      return { username, wrappedEnvDek: await wrapSecretForPublicKey(newDek, publicKey) };
    }),
  );
  // Earlier versions are sealed under the old key: re-seal each under the new one, so a
  // removed member's copy of the old key opens nothing. Unreadable ones are left out (dropped).
  const aad = envAad(loc.tenantId, loc.project, loc.name);
  const exported = await api.environments.versions.export(loc);
  const resealed: Array<{ id: string; version: number; payload: SealedBox }> = [];
  for (const v of exported) {
    try {
      resealed.push({ id: v.id, version: v.version, payload: await sealEnvData(await openEnvData(v.payload, currentDek, aad), newDek, aad) });
    } catch {
      /* corrupt or foreign version: it can't be carried over */
    }
  }
  // Everything goes in one request with a size cap: keep the newest versions that fit, so a long
  // history can never stop a revoking rotation from going through.
  const request = {
    ...loc,
    payload: await sealEnvData(env, newDek, aad),
    keyWraps,
    baseUpdatedAt: current.updatedAt,
  };
  const { kept } = fitHistory(request, resealed);
  await api.environments.rotate({ ...request, history: kept.map(({ id, payload }) => ({ id, payload })) });
  return { dek: newDek, droppedVersions: exported.length - kept.length };
}

/** Revoke by rotating: the revoked user keeps no usable key for current data. */
export async function revokeEnvironmentAccess(
  s: Session,
  project: string,
  envName: string,
  username: string,
  envDek: string,
): Promise<{ droppedVersions: number }> {
  return call(async () => {
    const { droppedVersions } = await rotateEnvironment(
      s,
      { tenantId: s.activeTenantId, project, name: envName },
      envDek,
      [username],
    );
    return { droppedVersions };
  });
}

// ── instance administration ────────────────────────────────────────────────

export const adminListUsers = (s: Session) => call(() => createClient(s).admin.users.list());

export async function adminSetUserStatus(
  s: Session,
  username: string,
  status: "active" | "disabled",
): Promise<void> {
  await call(() => createClient(s).admin.users.setStatus({ username, status }));
}

export async function adminSetUserRole(s: Session, username: string, role: Role): Promise<void> {
  await call(() => createClient(s).admin.users.setRole({ username, role }));
}

export const adminListInvites = (s: Session) => call(() => createClient(s).admin.invites.list());

export async function adminCreateInvite(
  s: Session,
  input: { expiresInHours: number; note: string; tenantId?: string; tenantRole?: "admin" | "member" },
): Promise<{ id: string; link: string; expiresAt: string }> {
  const created = await call(() => createClient(s).admin.invites.create(input));
  // Token lives in the URL fragment, so it is never sent to a server in a GET.
  return {
    id: created.id,
    expiresAt: created.expiresAt,
    link: `${resolveApiBase()}/#invite=${encodeURIComponent(created.token)}`,
  };
}

export async function adminRevokeInvite(s: Session, id: string): Promise<void> {
  await call(() => createClient(s).admin.invites.revoke({ id }));
}

export async function listAudit(
  s: Session,
  opts: { scope: "instance" | "workspace"; tenantId?: string; before?: string; limit?: number },
): Promise<AuditEvent[]> {
  return call(() =>
    opts.scope === "instance"
      ? createClient(s).admin.audit.list({ limit: opts.limit, before: opts.before })
      : createClient(s).tenants.audit({
          tenantId: opts.tenantId ?? s.activeTenantId,
          limit: opts.limit,
          before: opts.before,
        }),
  );
}

// ── service tokens (machine access for CI) ─────────────────────────────────

export const listServiceAccounts = (s: Session, tenantId: string) =>
  call(() => createClient(s).serviceAccounts.list({ tenantId }));

/** Every environment you may share in this workspace — the candidates for a token's access. */
export async function listGrantableEnvironments(
  s: Session,
): Promise<Array<{ project: string; env: string }>> {
  return call(async () => {
    const projects = await createClient(s).projects.list({ tenantId: s.activeTenantId });
    const out: Array<{ project: string; env: string }> = [];
    for (const p of projects) {
      for (const e of await listEnvironments(s, p.name)) {
        if (hasCap(e.level, e.caps, "share")) out.push({ project: p.name, env: e.name });
      }
    }
    return out;
  });
}

/**
 * Create a machine account and grant it access to the chosen environments. The
 * keypair is generated here, so the private key exists only inside the returned
 * token string — the server never sees it. The token is shown once.
 */
export async function createServiceToken(
  s: Session,
  input: {
    name: string;
    expiresInDays: number;
    grants: Array<{ project: string; env: string; level: Level }>;
  },
): Promise<{ token: string; username: string; expiresAt: string }> {
  return call(async () => {
    const tenantId = s.activeTenantId;
    const api = createClient(s);
    const keys = await generateIdentityKeyPair();
    const created = await api.serviceAccounts.create({
      tenantId,
      name: input.name,
      publicKey: keys.publicKey,
      expiresInDays: input.expiresInDays,
    });
    try {
      for (const g of input.grants) {
        const meta = (await listEnvironments(s, g.project)).find((e) => e.name === g.env);
        if (!meta?.envDek) throw new Error(`No access to ${g.project}/${g.env}`);
        await api.environments.grantAccess({
          tenantId,
          project: g.project,
          name: g.env,
          username: created.username,
          level: g.level,
          wrappedEnvDek: await wrapSecretForPublicKey(meta.envDek, keys.publicKey),
          keyVersion: meta.keyVersion,
        });
      }
    } catch (err) {
      // Don't leave a half-configured credential behind.
      await api.serviceAccounts.revoke({ tenantId, username: created.username }).catch(() => undefined);
      throw err;
    }
    return {
      username: created.username,
      expiresAt: created.expiresAt,
      token: encodeServiceToken({
        v: 1,
        u: created.username,
        t: created.token,
        k: keys.privateKey,
        w: tenantId,
        r: resolveApiBase(),
      }),
    };
  });
}

export async function revokeServiceToken(
  s: Session,
  username: string,
): Promise<{ rotated: number; notRotated: string[] }> {
  return call(async () => {
    const tenantId = s.activeTenantId;
    const res = await createClient(s).serviceAccounts.revoke({ tenantId, username });
    return rotateAffected(s, tenantId, res.rotate);
  });
}

// ── devices (sessions) ─────────────────────────────────────────────────────

export const listSessions = (s: Session) => call(() => createClient(s).sessions.list());

export async function revokeSession(s: Session, id: string): Promise<void> {
  await call(() => createClient(s).sessions.revoke({ id }));
}

export async function revokeOtherSessions(s: Session): Promise<void> {
  await call(() => createClient(s).sessions.revokeOthers());
}

export const verifyAuditLog = (s: Session) => call(() => createClient(s).admin.audit.verify());

/** Finish a key rotation that a removal left pending (re-key under a fresh DEK for current members). */
export async function rotateEnvironmentNow(
  s: Session,
  project: string,
  envName: string,
  envDek: string,
): Promise<{ droppedVersions: number }> {
  return call(async () => {
    const { droppedVersions } = await rotateEnvironment(
      s,
      { tenantId: s.activeTenantId, project, name: envName },
      envDek,
      [],
    );
    return { droppedVersions };
  });
}

// ── kubernetes links ───────────────────────────────────────────────────────

export type K8sCluster = {
  cluster: string;
  status: string;
  /** When the operator last asked the hub for its links; null until it first does. */
  lastSeen: string | null;
  version: string;
  namespaces: string[];
  /** When the token stops working, from the hub's own record; null once it has expired. */
  expiresAt: string | null;
  tokenExpiresAt: string | null;
};

export type K8sLink = {
  id: string;
  project: string;
  environment: string;
  cluster: string;
  namespace: string;
  secretName: string;
  direction: "pull" | "push";
  /** The key group this link carries ("default" for keys that have no group). */
  group: string;
  /** What it writes: a Secret, or a ConfigMap for settings that are not sensitive. */
  kind: "Secret" | "ConfigMap";
  /** A pull link that may take over a Secret already in the cluster instead of refusing it. */
  adopt: boolean;
  /** What the operator last reported (Synced, Pushed, or a reason it failed); empty until it has. */
  status: string;
  message: string;
  keyCount: number;
  reportedAt: string;
};

/** A cluster is a service token named k8s-…; its token goes into the cluster once, for the operator. */
export async function connectCluster(
  s: Session,
  name: string,
): Promise<{ token: string; username: string; expiresAt: string }> {
  return createServiceToken(s, { name: `k8s-${name}`, expiresInDays: 365, grants: [] });
}

/** More time for a token that still works. Same token and key, so nothing changes in the cluster. */
export const extendCluster = (s: Session, cluster: string) =>
  call(() => createClient(s).k8s.clusters.extend({ tenantId: s.activeTenantId, cluster, expiresInDays: 365 }));

/**
 * For a token that has expired (its key cannot be recovered): make a new one, give it the same
 * environments, hand the links over and retire the old one. The new token is shown once, to be
 * put into the cluster in place of the old.
 */
export async function replaceCluster(
  s: Session,
  oldCluster: string,
): Promise<{ token: string; username: string; expiresAt: string; moved: number }> {
  return call(async () => {
    const api = createClient(s);
    const tenantId = s.activeTenantId;
    const links = await api.k8s.clusters.links({ tenantId, cluster: oldCluster });
    const grants = new Map<string, { project: string; env: string; level: Level }>();
    for (const l of links) {
      const key = `${l.project}/${l.environment}`;
      const level: Level = l.direction === "push" || grants.get(key)?.level === "write" ? "write" : "read";
      grants.set(key, { project: l.project, env: l.environment, level });
    }
    // main -> main-r2 -> main-r3: the count says how many tokens this cluster has been through.
    const [, base, gen] = /^(.*?)(?:-r(\d+))?$/.exec(oldCluster.replace(/^svc-k8s-/, ""))!;
    const fresh = await createServiceToken(s, {
      name: `k8s-${base.slice(0, 18)}-r${Number(gen ?? 1) + 1}`,
      expiresInDays: 365,
      grants: [...grants.values()],
    });
    try {
      const { moved } = await api.k8s.clusters.replace({ tenantId, from: oldCluster, to: fresh.username });
      await revokeServiceToken(s, oldCluster);
      return { ...fresh, moved };
    } catch (err) {
      await api.serviceAccounts.revoke({ tenantId, username: fresh.username }).catch(() => undefined);
      throw err;
    }
  });
}

export const listClusters = (s: Session) =>
  call(() => createClient(s).k8s.clusters.list({ tenantId: s.activeTenantId }));

export const listK8sLinks = (s: Session, project: string, env: string) =>
  call(() => createClient(s).k8s.links.list({ tenantId: s.activeTenantId, project, name: env }));

/**
 * Link an environment to a Secret. Granting the cluster token the environment's key has to happen
 * here, in the browser, because only a person who holds the key can wrap it; the hub cannot.
 */
export async function linkEnvironment(
  s: Session,
  input: {
    project: string;
    env: string;
    envDek: string;
    keyVersion: number;
    cluster: string;
    namespace: string;
    secretName: string;
    direction: "pull" | "push";
    /** Take over a Secret that already exists in the cluster (pull only). */
    adopt?: boolean;
    group?: string;
    kind?: "Secret" | "ConfigMap";
  },
): Promise<void> {
  await call(async () => {
    const api = createClient(s);
    const grantee = await prepareGrant(s, input.cluster);
    await api.environments.grantAccess({
      tenantId: s.activeTenantId,
      project: input.project,
      name: input.env,
      username: input.cluster,
      level: input.direction === "push" ? "write" : "read",
      caps: [],
      wrappedEnvDek: await wrapSecretForPublicKey(input.envDek, grantee.publicKey),
      keyVersion: input.keyVersion,
    });
    savePin(grantee.username, grantee.fingerprint);
    await api.k8s.links.create({
      tenantId: s.activeTenantId,
      project: input.project,
      name: input.env,
      cluster: input.cluster,
      namespace: input.namespace,
      secretName: input.secretName,
      direction: input.direction,
      adopt: input.adopt === true,
      group: input.group || "default",
      kind: input.kind ?? "Secret",
    });
  });
}

export const setLinkAdopt = (s: Session, id: string, adopt: boolean) =>
  call(() => createClient(s).k8s.links.adopt({ tenantId: s.activeTenantId, id, adopt }));

export const unlinkEnvironment = (s: Session, id: string) =>
  call(() => createClient(s).k8s.links.delete({ tenantId: s.activeTenantId, id }));
