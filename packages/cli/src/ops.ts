import {
  checkPin,
  envAad,
  fitHistory,
  formatFingerprint,
  generateDek,
  keyFingerprintHex,
  openEnv,
  sealEnv,
  wrapSecretForPublicKey,
  type AclCap,
  type PinCheck,
  type SealedBox,
} from "@envvault/shared";
import { loadPins, requireRemote, requireSession, savePin, type EnvVaultConfig } from "./config.js";
import {
  createHubClient,
  hubGetEnv,
  hubSaveEnv,
  resolveEnv,
  type AccessEntry,
  type AccessLevel,
  type History,
  type Loc,
} from "./remote.js";

/**
 * Environment management beyond read/write: history, access, key rotation, deletion.
 * Like everything in this CLI, the cryptography happens here; the hub sees only ciphertext
 * and wrapped keys.
 */

type Target = { config: EnvVaultConfig; project: string; env: string; tenantId?: string };

async function locate(t: Target) {
  const session = requireSession(t.config);
  const resolved = await resolveEnv(t.config, t.project, t.env, t.tenantId);
  const client = createHubClient(requireRemote(t.config), session);
  const loc: Loc = { tenantId: resolved.tenantId, project: t.project, name: resolved.name };
  return { session, resolved, client, loc, aad: envAad(loc.tenantId, loc.project, loc.name) };
}

// ── deletion ────────────────────────────────────────────────────────────────

export async function hubDeleteEnv(t: Target): Promise<void> {
  const { client, loc } = await locate(t);
  await client.environments.delete(loc);
}

export async function hubDeleteProject(config: EnvVaultConfig, name: string, tenantId?: string): Promise<void> {
  const session = requireSession(config);
  const client = createHubClient(requireRemote(config), session);
  await client.projects.delete({ tenantId: tenantId ?? session.activeTenantId, name });
}

// ── history ─────────────────────────────────────────────────────────────────

export async function hubHistory(t: Target): Promise<History> {
  const { client, loc } = await locate(t);
  return client.environments.versions.list(loc);
}

/** The decrypted contents of an earlier version, by its version number. */
export async function hubReadVersion(
  t: Target,
  version: number,
): Promise<{ env: Record<string, string>; id: string }> {
  const { client, loc, resolved, aad } = await locate(t);
  const found = (await client.environments.versions.list(loc)).history.find((v) => v.version === version);
  if (!found) throw new Error(historyMiss(version, await client.environments.versions.list(loc)));
  const got = await client.environments.versions.get({ ...loc, id: found.id });
  return { env: await openEnv(got.payload, resolved.envDek, aad), id: found.id };
}

function historyMiss(version: number, h: History): string {
  const known = h.history.map((v) => v.version);
  return known.length
    ? `No saved version ${version}. Saved versions: ${known.join(", ")} (current is ${h.current.version}).`
    : `No saved version ${version}: this environment has no earlier versions yet.`;
}

/** Save an earlier version's contents as a new version (the old one stays in history). */
export async function hubRestoreVersion(t: Target, version: number): Promise<{ updatedAt: string; keys: number }> {
  const { env } = await hubReadVersion(t, version);
  const current = await hubGetEnv(t.config, t.project, t.env, t.tenantId);
  const saved = await hubSaveEnv(
    t.config, t.project, t.env, env, t.tenantId, current.updatedAt, `Restored from v${version}`,
  );
  return { updatedAt: saved.updatedAt, keys: Object.keys(env).length };
}

export async function hubDeleteVersion(t: Target, version: number): Promise<void> {
  const { client, loc } = await locate(t);
  const h = await client.environments.versions.list(loc);
  const found = h.history.find((v) => v.version === version);
  if (!found) throw new Error(historyMiss(version, h));
  await client.environments.versions.delete({ ...loc, id: found.id });
}

// ── access ──────────────────────────────────────────────────────────────────

export async function hubListAccess(t: Target): Promise<AccessEntry[]> {
  const { client, loc } = await locate(t);
  return client.environments.listAccess(loc);
}

export type PreparedKey = PinCheck & { publicKey: string; username: string; display: string };

/** Look a person's key up and compare it with what this machine has pinned. */
export async function hubPrepareKey(config: EnvVaultConfig, username: string): Promise<PreparedKey> {
  const session = requireSession(config);
  const name = username.trim().toLowerCase();
  const client = createHubClient(requireRemote(config), session);
  const { publicKey } = await client.users.resolve({ username: name });
  const fp = await keyFingerprintHex(publicKey);
  const check = checkPin(loadPins(requireRemote(config)), name, fp);
  return { ...check, publicKey, username: name, display: formatFingerprint(fp) };
}

/**
 * Grant (or change) someone's access. `trust` is asked when their key is new or has
 * changed; return false to cancel.
 */
export async function hubGrantAccess(
  t: Target,
  username: string,
  level: AccessLevel,
  caps: AclCap[],
  trust: (prepared: PreparedKey) => Promise<boolean>,
): Promise<boolean> {
  const { client, loc, resolved } = await locate(t);
  const prepared = await hubPrepareKey(t.config, username);
  if (prepared.status !== "match" && !(await trust(prepared))) return false;
  await client.environments.grantAccess({
    ...loc,
    username: prepared.username,
    level,
    caps,
    wrappedEnvDek: await wrapSecretForPublicKey(resolved.envDek, prepared.publicKey),
    keyVersion: resolved.keyVersion,
  });
  savePin(requireRemote(t.config), prepared.username, prepared.fingerprint);
  return true;
}

// ── key rotation ────────────────────────────────────────────────────────────

/**
 * Re-encrypt an environment (and its saved versions) under a fresh key, wrapped only for
 * everyone who should keep access: the current list minus `exclude`. Used both to rotate
 * and to revoke, since access is only really taken back once the key changes.
 */
export async function hubRotate(
  t: Target,
  exclude: string[] = [],
): Promise<{ kept: string[]; removed: string[]; versionsKept: number; versionsDropped: number }> {
  const { session, client, loc, resolved, aad } = await locate(t);
  const remote = requireRemote(t.config);
  const current = await client.environments.getEnv(loc);
  const env = await openEnv(current.payload, resolved.envDek, aad);

  const acl = await client.environments.listAccess(loc);
  const drop = new Set(exclude.map((u) => u.toLowerCase()));
  const unknown = [...drop].filter((u) => !acl.some((a) => a.username === u));
  if (unknown.length) throw new Error(`${unknown.join(", ")} ${unknown.length === 1 ? "doesn't have" : "don't have"} access to this environment.`);
  const keep = acl.map((a) => a.username).filter((u) => !drop.has(u));

  const newDek = generateDek();
  const pins = loadPins(remote);
  const keyWraps = await Promise.all(
    keep.map(async (username) => {
      const { publicKey } =
        username === session.username
          ? { publicKey: session.publicKey }
          : await client.users.resolve({ username });
      const check = checkPin(pins, username, await keyFingerprintHex(publicKey));
      if (check.status === "changed") {
        throw new Error(
          `The public key for "${username}" has changed since you last saw it. ` +
            "Verify it with them, then run `envvault trust reset`.",
        );
      }
      return { username, wrappedEnvDek: await wrapSecretForPublicKey(newDek, publicKey) };
    }),
  );

  // Earlier versions are sealed under the old key: re-seal each under the new one so a removed
  // member's copy of the old key opens nothing. Ones that can't be read are dropped.
  const exported = await client.environments.versions.export(loc);
  const resealed: Array<{ id: string; version: number; payload: SealedBox }> = [];
  for (const v of exported) {
    try {
      resealed.push({ id: v.id, version: v.version, payload: await sealEnv(await openEnv(v.payload, resolved.envDek, aad), newDek, aad) });
    } catch {
      /* corrupt or foreign version: it can't be carried over */
    }
  }
  // Everything goes in one request with a size cap: keep the newest versions that fit.
  const request = {
    ...loc,
    payload: await sealEnv(env, newDek, aad),
    keyWraps,
    baseUpdatedAt: current.updatedAt,
  };
  const { kept: history } = fitHistory(request, resealed);
  await client.environments.rotate({ ...request, history: history.map(({ id, payload }) => ({ id, payload })) });
  return {
    kept: keep,
    removed: [...drop],
    versionsKept: history.length,
    versionsDropped: exported.length - history.length,
  };
}
