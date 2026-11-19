import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  DEFAULT_ENV_NAME,
  DEFAULT_KDF,
  checkPin,
  createAccountMaterial,
  derivePublicKey,
  deriveFromPassword,
  deriveRecoveryKeys,
  envAad,
  formatFingerprint,
  generateDek,
  keyFingerprintHex,
  openEnv,
  openPrivateKey,
  openRecoveredPrivateKey,
  privateKeyAad,
  seal,
  sealEnv,
  unwrapSecretWithPrivateKey,
  wrapSecretForPublicKey,
  type KdfParams,
  type SealedBox,
} from "@envvault/shared";
import type { CliSession, EnvVaultConfig } from "./config.js";
import { loadPins, requireRemote, requireSession, savePin } from "./config.js";
import { unlockPrivateKey } from "./keystore.js";

/**
 * All cryptography happens in this process. The hub only ever receives a login
 * proof (never the password), public keys, wrapped keys and ciphertext.
 */

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
  /** Extra permissions (comma list: delete, share, rotate); empty for read/write and for managers. */
  caps?: string;
  wrappedEnvDek: string;
  /** Which key generation `wrappedEnvDek` belongs to; a grant must carry it back. */
  keyVersion: number;
  envDek?: string;
};

export type ProjectEnv = {
  name: string;
  tenantId: string;
  projectName: string;
  updatedAt: string;
  env: Record<string, string>;
};

export type KeyWrap = { username: string; wrappedEnvDek: string };
export type AccessLevel = "read" | "write" | "manage";
export type AccessEntry = { username: string; level: AccessLevel; caps: string[] };
export type VersionMeta = {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  note: string;
};
export type History = {
  current: { version: number; updatedAt: string; updatedBy: string; note: string };
  history: VersionMeta[];
};
type AuthResult = {
  token: string;
  username: string;
  publicKey: string;
  wrappedPrivateKey: SealedBox;
  personalTenantId: string;
};
export type Loc = { tenantId: string; project: string; name: string };

/** Minimal hub surface used by the CLI (avoids importing the server router). */
type HubClient = {
  prelogin: (input: { username: string }) => Promise<{ kdf: KdfParams }>;
  login: (input: { username: string; authKey: string }) => Promise<AuthResult>;
  signup: (input: {
    username: string;
    authKey: string;
    kdf: KdfParams;
    publicKey: string;
    wrappedPrivateKey: SealedBox;
    recovery: { authKey: string; wrappedPrivateKey: SealedBox };
    inviteToken?: string;
  }) => Promise<AuthResult>;
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
  };
  tenants: {
    list: () => Promise<TenantMeta[]>;
    keyRecipients: (input: { tenantId: string }) => Promise<{ username: string; publicKey: string }[]>;
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
  users: {
    resolve: (input: { username: string }) => Promise<{ username: string; publicKey: string }>;
  };
  environments: {
    list: (input: { tenantId: string; project: string }) => Promise<Omit<EnvMeta, "envDek">[]>;
    create: (
      input: Loc & { payload: SealedBox; keyWraps: KeyWrap[] },
    ) => Promise<{ name: string; updatedAt: string }>;
    delete: (input: Loc) => Promise<{ ok: true }>;
    versions: {
      list: (input: Loc) => Promise<History>;
      get: (input: Loc & { id: string }) => Promise<VersionMeta & { payload: SealedBox }>;
      delete: (input: Loc & { id: string }) => Promise<{ ok: true }>;
      export: (input: Loc) => Promise<Array<{ id: string; version: number; payload: SealedBox }>>;
    };
    grantAccess: (
      input: Loc & { username: string; level: AccessLevel; caps: string[]; wrappedEnvDek: string; keyVersion: number },
    ) => Promise<{ ok: true }>;
    listAccess: (input: Loc) => Promise<AccessEntry[]>;
    rotate: (
      input: Loc & {
        payload: SealedBox;
        keyWraps: KeyWrap[];
        baseUpdatedAt?: string;
        history: Array<{ id: string; payload: SealedBox }>;
      },
    ) => Promise<{ ok: true; updatedAt: string }>;
    getEnv: (input: Loc) => Promise<{
      tenantId: string;
      projectName: string;
      name: string;
      updatedAt: string;
      payload: SealedBox;
    }>;
    saveEnv: (
      input: Loc & { payload: SealedBox; baseUpdatedAt?: string; note?: string },
    ) => Promise<{ name: string; updatedAt: string }>;
  };
};

/**
 * You can't do this: the environment is hidden from you, or your access is too low. Sync
 * commands treat it differently from real failures (see `--skip-denied`).
 */
export class NoAccessError extends Error {
  override name = "NoAccessError";
}

/** True for a denial from the hub (403) or one we raised ourselves. */
export function isDenied(err: unknown): boolean {
  if (err instanceof NoAccessError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return code === "FORBIDDEN";
}

/** Re-throw a denial with the action and target spelled out; anything else passes through. */
export function explainDenied(err: unknown, action: string, project: string, env: string): never {
  if (isDenied(err) && !(err instanceof NoAccessError)) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new NoAccessError(`Not allowed to ${action} ${project}/${env}: ${reason}.`);
  }
  throw err;
}

const clientCache = new Map<string, HubClient>();

/** One client per (remote, token): tree sync reuses it across targets. */
export function createHubClient(remote: string, session?: CliSession): HubClient {
  const key = [remote, session?.token ?? ""].join("\0");
  let client = clientCache.get(key);
  if (!client) {
    const link = new RPCLink({
      url: `${remote.replace(/\/$/, "")}/rpc`,
      headers: () => (session ? { authorization: `Bearer ${session.token}` } : {}),
    });
    client = createORPCClient(link) as HubClient;
    clientCache.set(key, client);
  }
  return client;
}

/** Refuse a session whose public key isn't the one belonging to our private key. */
async function verifiedSession(
  result: AuthResult,
  privateKey: string,
  passwordKey: { wrapped: SealedBox; kdf: KdfParams },
): Promise<CliSession> {
  if ((await derivePublicKey(privateKey)) !== result.publicKey) {
    throw new Error(
      "The hub returned a public key that does not match your private key. Do not continue.",
    );
  }
  return {
    token: result.token,
    username: result.username,
    publicKey: result.publicKey,
    personalTenantId: result.personalTenantId,
    activeTenantId: result.personalTenantId,
    privateKey,
    passwordKey,
  };
}

export async function hubLogin(
  config: EnvVaultConfig,
  username: string,
  password: string,
): Promise<CliSession> {
  const client = createHubClient(requireRemote(config));
  const name = username.trim().toLowerCase();
  const { kdf } = await client.prelogin({ username: name });
  const keys = await deriveFromPassword(password, name, kdf);
  const result = await client.login({ username: name, authKey: keys.authKey });
  const privateKey = await openPrivateKey(result.wrappedPrivateKey, keys.wrapKey, name);
  return verifiedSession(result, privateKey, { wrapped: result.wrappedPrivateKey, kdf });
}

/**
 * Create an account from an admin-issued invite (or the first-run setup token).
 * Returns the recovery key, which the caller must show once.
 */
export async function hubSignup(
  config: EnvVaultConfig,
  username: string,
  password: string,
  inviteToken?: string,
): Promise<{ session: CliSession; recoveryKey: string }> {
  const client = createHubClient(requireRemote(config));
  const name = username.trim().toLowerCase();
  const m = await createAccountMaterial(name, password, DEFAULT_KDF);
  const result = await client.signup({
    username: name,
    authKey: m.authKey,
    kdf: m.kdf,
    publicKey: m.publicKey,
    wrappedPrivateKey: m.wrappedPrivateKey,
    recovery: {
      authKey: m.recovery.recoveryAuthKey,
      wrappedPrivateKey: m.recovery.recoveryWrappedPrivateKey,
    },
    inviteToken,
  });
  return {
    session: await verifiedSession(result, m.privateKey, { wrapped: m.wrappedPrivateKey, kdf: m.kdf }),
    recoveryKey: m.recovery.recoveryKey,
  };
}

/** Forgot your password: prove the recovery key, set a new password. */
export async function hubRecover(
  config: EnvVaultConfig,
  username: string,
  recoveryKey: string,
  newPassword: string,
): Promise<CliSession> {
  const client = createHubClient(requireRemote(config));
  const name = username.trim().toLowerCase();
  const { recoveryAuthKey, recoveryWrapKey } = await deriveRecoveryKeys(recoveryKey);
  const bundle = await client.recovery.bundle({ username: name, recoveryAuthKey });
  const privateKey = await openRecoveredPrivateKey(bundle.recoveryWrappedPrivateKey, recoveryWrapKey, name);
  const next = await deriveFromPassword(newPassword, name, DEFAULT_KDF);
  const newWrapped = await seal(privateKey, next.wrapKey, privateKeyAad(name));
  const result = await client.recovery.recover({
    username: name,
    recoveryAuthKey,
    newAuthKey: next.authKey,
    newKdf: DEFAULT_KDF,
    newWrappedPrivateKey: newWrapped,
  });
  return verifiedSession(result, privateKey, { wrapped: newWrapped, kdf: DEFAULT_KDF });
}

export async function hubListTenants(config: EnvVaultConfig): Promise<TenantMeta[]> {
  return createHubClient(requireRemote(config), requireSession(config)).tenants.list();
}

export async function hubListProjects(
  config: EnvVaultConfig,
  tenantId?: string,
): Promise<ProjectMeta[]> {
  const session = requireSession(config);
  return createHubClient(requireRemote(config), session).projects.list({
    tenantId: tenantId ?? session.activeTenantId,
  });
}

/** What you may do with each environment of a project. No keys are opened, so it's cheap and never prompts. */
export async function hubEnvironmentAccess(
  config: EnvVaultConfig,
  project: string,
  tenantId?: string,
): Promise<Array<{ name: string; level: AccessLevel; caps: string }>> {
  const session = requireSession(config);
  const rows = await createHubClient(requireRemote(config), session).environments.list({
    tenantId: tenantId ?? session.activeTenantId,
    project,
  });
  return rows.map((r) => ({ name: r.name, level: r.level, caps: r.caps ?? "" }));
}

export async function hubListEnvironments(
  config: EnvVaultConfig,
  project: string,
  tenantId?: string,
  /** Only RSA-unwrap this environment (unwrapping is the expensive part). */
  only?: string,
): Promise<{ accessible: EnvMeta[]; listed: string[]; unwrapFailed: string[] }> {
  const session = requireSession(config);
  const remote = requireRemote(config);
  const rows = await createHubClient(remote, session).environments.list({
    tenantId: tenantId ?? session.activeTenantId,
    project,
  });

  const unwrapFailed: string[] = [];
  // Decrypted only now, in memory (keychain or password unlock), and only if there's work to do.
  const privateKey = rows.some((r) => !only || r.name === only)
    ? await unlockPrivateKey(session, remote)
    : "";
  const unwrapped = await Promise.all(
    rows.map(async (row): Promise<EnvMeta | null> => {
      if (only && row.name !== only) return null;
      try {
        return { ...row, envDek: await unwrapSecretWithPrivateKey(row.wrappedEnvDek, privateKey) };
      } catch {
        unwrapFailed.push(row.name);
        return null;
      }
    }),
  );
  return {
    accessible: unwrapped.filter((e): e is EnvMeta => e !== null),
    listed: rows.map((r) => r.name),
    unwrapFailed,
  };
}

export async function resolveEnv(
  config: EnvVaultConfig,
  project: string,
  envName: string,
  tenantId?: string,
): Promise<{
  tenantId: string;
  envDek: string;
  updatedAt: string;
  name: string;
  level: AccessLevel;
  caps: string;
  keyVersion: number;
}> {
  const session = requireSession(config);
  const tid = tenantId ?? session.activeTenantId;
  const name = envName.trim().toLowerCase() || DEFAULT_ENV_NAME;
  const { accessible, listed, unwrapFailed } = await hubListEnvironments(config, project, tid, name);
  const match = accessible.find((e) => e.name === name);
  if (match?.envDek) {
    return {
      tenantId: tid,
      envDek: match.envDek,
      updatedAt: match.updatedAt,
      name,
      level: match.level,
      caps: match.caps ?? "",
      keyVersion: match.keyVersion,
    };
  }

  if (unwrapFailed.includes(name)) {
    throw new Error(
      `Environment "${project}/${name}" is shared with you but your key couldn't open it. ` +
        "Ask someone with the share permission to grant it to you again.",
    );
  }
  // The hub never says whether something is hidden from you or simply doesn't exist.
  const projectNames = (await hubListProjects(config, tid)).map((p) => p.name);
  const detail = !projectNames.includes(project)
    ? `Either it doesn't exist or you haven't been granted access (the hub doesn't say which). ` +
      `Projects you can open in this workspace: ${projectNames.join(", ") || "none"}. ` +
      "If it's in another workspace, pass -t or run `envvault use`."
    : listed.length === 0
      ? `You can't open any environment of "${project}". Ask for access to be granted.`
      : `Environments of "${project}" you can open: ${listed.join(", ")}.`;
  throw new NoAccessError(`No access to ${project}/${name}. ${detail}`);
}

export async function hubGetEnv(
  config: EnvVaultConfig,
  project: string,
  envName = DEFAULT_ENV_NAME,
  tenantId?: string,
): Promise<ProjectEnv> {
  const session = requireSession(config);
  const resolved = await resolveEnv(config, project, envName, tenantId);
  const got = await createHubClient(requireRemote(config), session)
    .environments.getEnv({ tenantId: resolved.tenantId, project, name: resolved.name })
    .catch((err) => explainDenied(err, "read", project, resolved.name));
  return {
    name: got.name,
    tenantId: got.tenantId,
    projectName: got.projectName,
    updatedAt: got.updatedAt,
    env: await openEnv(got.payload, resolved.envDek, envAad(got.tenantId, project, got.name)),
  };
}

export async function hubSaveEnv(
  config: EnvVaultConfig,
  project: string,
  envName: string,
  env: Record<string, string>,
  tenantId?: string,
  /** Reject the write if the environment changed since this updatedAt. */
  baseUpdatedAt?: string,
  /** Label for this version in the history. */
  note?: string,
): Promise<ProjectEnv> {
  const session = requireSession(config);
  const resolved = await resolveEnv(config, project, envName, tenantId);
  const saved = await createHubClient(requireRemote(config), session)
    .environments.saveEnv({
      tenantId: resolved.tenantId,
      project,
      name: resolved.name,
      payload: await sealEnv(env, resolved.envDek, envAad(resolved.tenantId, project, resolved.name)),
      baseUpdatedAt,
      note: note || undefined,
    })
    .catch((err) => explainDenied(err, "write to", project, resolved.name));
  return {
    name: resolved.name,
    tenantId: resolved.tenantId,
    projectName: project,
    updatedAt: saved.updatedAt,
    env,
  };
}

/**
 * Wrap `dek` for everyone in the workspace who gets new environments (owner, admins, you).
 * Never trusts the hub's copy of our own key; pins everyone else on first use.
 */
async function wrapForTenant(
  config: EnvVaultConfig,
  client: HubClient,
  session: CliSession,
  tenantId: string,
  dek: string,
): Promise<KeyWrap[]> {
  const remote = requireRemote(config);
  const pins = loadPins(remote);
  const recipients = await client.tenants.keyRecipients({ tenantId });
  return Promise.all(
    recipients.map(async (r) => {
      const publicKey = r.username === session.username ? session.publicKey : r.publicKey;
      const fp = await keyFingerprintHex(publicKey);
      const check = checkPin(pins, r.username, fp);
      if (check.status === "changed") {
        throw new Error(
          `The public key for "${r.username}" has changed (now ${formatFingerprint(fp)}). ` +
            "Verify it with them, then run `envvault trust reset`.",
        );
      }
      if (check.status === "new") savePin(remote, r.username, fp);
      return { username: r.username, wrappedEnvDek: await wrapSecretForPublicKey(dek, publicKey) };
    }),
  );
}

function requireHuman(session: CliSession, what: string): void {
  if (!session.publicKey) throw new Error(`Service tokens cannot ${what}. Log in as a user.`);
}

export async function hubCreateProject(
  config: EnvVaultConfig,
  name: string,
  tenantId?: string,
): Promise<{ name: string; tenantId: string; envDek: string }> {
  const session = requireSession(config);
  requireHuman(session, "create projects");
  const client = createHubClient(requireRemote(config), session);
  const tid = tenantId ?? session.activeTenantId;
  const envDek = generateDek();
  const [keyWraps, payload] = await Promise.all([
    wrapForTenant(config, client, session, tid, envDek),
    sealEnv({}, envDek, envAad(tid, name, DEFAULT_ENV_NAME)),
  ]);
  const created = await client.projects.create({ tenantId: tid, name, payload, keyWraps });
  return { name: created.name, tenantId: created.tenantId, envDek };
}

/** Add an environment to a project you can manage. It starts empty. */
export async function hubCreateEnv(
  config: EnvVaultConfig,
  project: string,
  name: string,
  tenantId?: string,
): Promise<{ name: string; updatedAt: string }> {
  const session = requireSession(config);
  requireHuman(session, "create environments");
  const client = createHubClient(requireRemote(config), session);
  const tid = tenantId ?? session.activeTenantId;
  const envName = name.trim().toLowerCase();
  const dek = generateDek();
  const [keyWraps, payload] = await Promise.all([
    wrapForTenant(config, client, session, tid, dek),
    sealEnv({}, dek, envAad(tid, project, envName)),
  ]);
  return client.environments.create({ tenantId: tid, project, name: envName, payload, keyWraps });
}

/**
 * Make sure a project and environment exist, creating whatever is missing (the workspace is never created).
 * The hub doesn't say whether a name is hidden from you or absent, so creation is insert-only: a name that
 * exists but you can't open comes back as a conflict and is reported as that, not overwritten.
 */
export async function ensureEnvironment(
  config: EnvVaultConfig,
  project: string,
  envName: string,
  tenantId?: string,
): Promise<{ createdProject: boolean; createdEnv: boolean }> {
  const session = requireSession(config);
  const tid = tenantId ?? session.activeTenantId;
  const name = envName.trim().toLowerCase() || DEFAULT_ENV_NAME;
  if ((await hubEnvironmentAccess(config, project, tid)).some((e) => e.name === name)) {
    return { createdProject: false, createdEnv: false };
  }
  const projectVisible = (await hubListProjects(config, tid)).some((p) => p.name === project);
  try {
    if (!projectVisible) {
      await hubCreateProject(config, project, tid); // starts with a `default` environment
      if (name !== DEFAULT_ENV_NAME) await hubCreateEnv(config, project, name, tid);
      return { createdProject: true, createdEnv: true };
    }
    await hubCreateEnv(config, project, name, tid);
    return { createdProject: false, createdEnv: true };
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "CONFLICT") {
      throw new NoAccessError(
        `${project}/${name} already exists but you can't open it, so it wasn't created. Ask for access to be granted.`,
      );
    }
    return explainDenied(err, "create", project, name);
  }
}

export function hasRemote(config: EnvVaultConfig): boolean {
  return Boolean(process.env.ENVVAULT_REMOTE ?? config.remote);
}
