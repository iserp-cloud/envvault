import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import type { SealedBox } from "@envvault/shared";
import type {
  Database as DbSchema,
  EnvironmentAclRow,
  EnvironmentKeyRow,
} from "./schema.js";

/** Newest previous versions kept per environment; older ones are pruned on save. */
export const MAX_ENV_HISTORY = 50;

export type StoredEnvironment = {
  tenantId: string;
  projectName: string;
  name: string;
  updatedAt: string;
  payload: SealedBox;
  /** 1 for a new environment, +1 on every save. */
  version: number;
  updatedBy: string;
  note: string;
};

function rowToStoredEnv(row: {
  tenant_id: string;
  project_name: string;
  name: string;
  updated_at: string;
  payload: string;
  version: number;
  updated_by: string;
  note: string;
}): StoredEnvironment {
  return {
    tenantId: row.tenant_id,
    projectName: row.project_name,
    name: row.name,
    updatedAt: row.updated_at,
    payload: JSON.parse(row.payload) as SealedBox,
    version: Number(row.version),
    updatedBy: row.updated_by,
    note: row.note,
  };
}

/** Run `fn` in a transaction, joining the caller's if `db` already is one. */
async function inTransaction<T>(
  db: Kysely<DbSchema>,
  fn: (trx: Kysely<DbSchema>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? fn(db) : db.transaction().execute(fn);
}

/** Create an environment (or overwrite one outright, e.g. project creation). Not for ordinary saves. */
/** Insert an environment that must not exist yet: a duplicate is a unique-key error, never an overwrite. */
export async function insertNewEnvironment(
  db: Kysely<DbSchema>,
  stored: Pick<StoredEnvironment, "tenantId" | "projectName" | "name" | "updatedAt" | "payload" | "updatedBy">,
): Promise<void> {
  await db
    .insertInto("environments")
    .values({
      tenant_id: stored.tenantId,
      project_name: stored.projectName,
      name: stored.name,
      updated_at: stored.updatedAt,
      payload: JSON.stringify(stored.payload),
      rotate_pending: 0,
      version: 1,
      updated_by: stored.updatedBy,
      note: "",
      key_version: 1,
    })
    .execute();
}

/**
 * Pin an environment's key generation for the rest of the transaction. Returns false when it isn't
 * `expected`, i.e. the key was rotated after the caller loaded it. The write changes nothing but
 * takes the row's lock, so a rotation can't slip in between this check and the caller's own writes.
 */
export async function holdKeyVersion(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
  expected: number,
): Promise<boolean> {
  const r = await db
    .updateTable("environments")
    .set({ key_version: expected })
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("name", "=", envName)
    .where("key_version", "=", expected)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

export async function upsertStoredEnvironment(
  db: Kysely<DbSchema>,
  stored: Omit<StoredEnvironment, "version" | "updatedBy" | "note"> &
    Partial<Pick<StoredEnvironment, "version" | "updatedBy" | "note">>,
): Promise<void> {
  await db
    .insertInto("environments")
    .values({
      tenant_id: stored.tenantId,
      project_name: stored.projectName,
      name: stored.name,
      updated_at: stored.updatedAt,
      payload: JSON.stringify(stored.payload),
      rotate_pending: 0,
      version: stored.version ?? 1,
      updated_by: stored.updatedBy ?? "",
      note: stored.note ?? "",
      key_version: 1,
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "project_name", "name"]).doUpdateSet({
        updated_at: stored.updatedAt,
        payload: JSON.stringify(stored.payload),
      }),
    )
    .execute();
}

export async function getStoredEnvironment(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
): Promise<StoredEnvironment | null> {
  const row = await db
    .selectFrom("environments")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("name", "=", envName)
    .executeTakeFirst();
  return row ? rowToStoredEnv(row) : null;
}

export async function hasStoredEnvironment(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("environments")
    .select("name")
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("name", "=", envName)
    .executeTakeFirst();
  return Boolean(row);
}

export async function countEnvironments(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
): Promise<number> {
  const row = await db
    .selectFrom("environments")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Save new content, only if the environment is still at `expectedUpdatedAt`. The payload it
 * replaces moves into history (and the oldest history beyond MAX_ENV_HISTORY is pruned), all
 * in one transaction. Returns false when someone else saved first, so two writers can't both win.
 */
export async function saveStoredEnvironmentIf(
  db: Kysely<DbSchema>,
  stored: Pick<StoredEnvironment, "tenantId" | "projectName" | "name" | "updatedAt" | "payload">,
  expectedUpdatedAt: string,
  meta: { by?: string; note?: string } = {},
): Promise<boolean> {
  return inTransaction(db, async (trx) => {
    const prev = await trx
      .selectFrom("environments")
      .selectAll()
      .where("tenant_id", "=", stored.tenantId)
      .where("project_name", "=", stored.projectName)
      .where("name", "=", stored.name)
      .where("updated_at", "=", expectedUpdatedAt)
      .executeTakeFirst();
    if (!prev) return false;

    const result = await trx
      .updateTable("environments")
      .set({
        updated_at: stored.updatedAt,
        payload: JSON.stringify(stored.payload),
        version: Number(prev.version) + 1,
        updated_by: meta.by ?? "",
        note: meta.note ?? "",
      })
      .where("tenant_id", "=", stored.tenantId)
      .where("project_name", "=", stored.projectName)
      .where("name", "=", stored.name)
      .where("updated_at", "=", expectedUpdatedAt)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) return false;

    await trx
      .insertInto("environment_versions")
      .values({
        id: randomUUID(),
        tenant_id: prev.tenant_id,
        project_name: prev.project_name,
        env_name: prev.name,
        version: Number(prev.version),
        payload: prev.payload,
        created_at: prev.updated_at,
        created_by: prev.updated_by,
        note: prev.note,
      })
      .execute();
    await trx
      .deleteFrom("environment_versions")
      .where("tenant_id", "=", prev.tenant_id)
      .where("project_name", "=", prev.project_name)
      .where("env_name", "=", prev.name)
      .where("version", "<=", Number(prev.version) - MAX_ENV_HISTORY)
      .execute();
    return true;
  });
}

/**
 * Key rotation: swap in the re-encrypted payload without creating a version, and replace the
 * history payloads with their re-encrypted copies. History the client didn't re-encrypt is
 * dropped (it would be unreadable under the new key). Returns false on a stale `expectedUpdatedAt`
 * or if `history` names a version that isn't this environment's.
 */
export async function reencryptStoredEnvironmentIf(
  db: Kysely<DbSchema>,
  stored: Pick<StoredEnvironment, "tenantId" | "projectName" | "name" | "updatedAt" | "payload">,
  expectedUpdatedAt: string,
  history: Array<{ id: string; payload: SealedBox }>,
): Promise<boolean> {
  return inTransaction(db, async (trx) => {
    const result = await trx
      .updateTable("environments")
      .set({
        updated_at: stored.updatedAt,
        payload: JSON.stringify(stored.payload),
        key_version: sql<number>`key_version + 1`, // a new key: wraps made for the old one are now stale
      })
      .where("tenant_id", "=", stored.tenantId)
      .where("project_name", "=", stored.projectName)
      .where("name", "=", stored.name)
      .where("updated_at", "=", expectedUpdatedAt)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) return false;

    for (const h of history) {
      const r = await trx
        .updateTable("environment_versions")
        .set({ payload: JSON.stringify(h.payload) })
        .where("id", "=", h.id)
        .where("tenant_id", "=", stored.tenantId)
        .where("project_name", "=", stored.projectName)
        .where("env_name", "=", stored.name)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw new Error("Unknown version in history");
    }
    let drop = trx
      .deleteFrom("environment_versions")
      .where("tenant_id", "=", stored.tenantId)
      .where("project_name", "=", stored.projectName)
      .where("env_name", "=", stored.name);
    if (history.length > 0) drop = drop.where("id", "not in", history.map((h) => h.id));
    await drop.execute();
    return true;
  });
}

export type EnvironmentVersionMeta = {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
  note: string;
};

type VersionRow = {
  id: string;
  version: number;
  created_at: string;
  created_by: string;
  note: string;
};

const versionMeta = (r: VersionRow): EnvironmentVersionMeta => ({
  id: r.id,
  version: Number(r.version),
  createdAt: r.created_at,
  createdBy: r.created_by,
  note: r.note,
});

/** Previous versions, newest first (metadata only: no ciphertext). */
export async function listEnvironmentVersions(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
): Promise<EnvironmentVersionMeta[]> {
  const rows = await db
    .selectFrom("environment_versions")
    .select(["id", "version", "created_at", "created_by", "note"])
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .orderBy("version", "desc")
    .execute();
  return rows.map(versionMeta);
}

export async function getEnvironmentVersion(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
  id: string,
): Promise<(EnvironmentVersionMeta & { payload: SealedBox }) | null> {
  const row = await db
    .selectFrom("environment_versions")
    .selectAll()
    .where("id", "=", id)
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .executeTakeFirst();
  return row ? { ...versionMeta(row), payload: JSON.parse(row.payload) as SealedBox } : null;
}

export async function listEnvironmentVersionPayloads(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
): Promise<Array<{ id: string; version: number; payload: SealedBox }>> {
  const rows = await db
    .selectFrom("environment_versions")
    .select(["id", "version", "payload"])
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .orderBy("version", "desc")
    .execute();
  return rows.map((r) => ({ id: r.id, version: Number(r.version), payload: JSON.parse(r.payload) as SealedBox }));
}

export async function deleteEnvironmentVersion(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
  id: string,
): Promise<boolean> {
  const r = await db
    .deleteFrom("environment_versions")
    .where("id", "=", id)
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

export type RemoveEnvironmentResult = "removed" | "missing" | "last";

/** Delete an environment atomically, refusing to remove a project's last one. */
export async function removeStoredEnvironment(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
): Promise<RemoveEnvironmentResult> {
  return db.transaction().execute(async (trx) => {
    // Take the project row's lock first so two concurrent deletes are counted one at a time.
    await trx
      .updateTable("projects")
      .set({ updated_at: sql<string>`updated_at` })
      .where("tenant_id", "=", tenantId)
      .where("name", "=", projectName)
      .execute();
    const total = await trx
      .selectFrom("environments")
      .select(sql<number>`count(*)`.as("n"))
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", projectName)
      .executeTakeFirst();
    if (Number(total?.n ?? 0) <= 1) return "last";

    await trx
      .deleteFrom("environment_keys")
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", projectName)
      .where("env_name", "=", envName)
      .execute();
    await trx
      .deleteFrom("environment_acl")
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", projectName)
      .where("env_name", "=", envName)
      .execute();
    await trx
      .deleteFrom("environment_versions")
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", projectName)
      .where("env_name", "=", envName)
      .execute();
    const result = await trx
      .deleteFrom("environments")
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", projectName)
      .where("name", "=", envName)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0 ? "removed" : "missing";
  });
}


export async function listEnvironmentsForUser(
  db: Kysely<DbSchema>,
  username: string,
  tenantId: string,
  projectName: string,
): Promise<
  Array<{
    name: string;
    updatedAt: string;
    level: "read" | "write" | "manage";
    caps: string;
    wrappedEnvDek: string;
    /** Which key generation `wrappedEnvDek` belongs to; send it back when granting access. */
    keyVersion: number;
    rotatePending: boolean;
  }>
> {
  const rows = await db
    .selectFrom("environment_keys")
    .innerJoin("environments", (join) =>
      join
        .onRef("environments.tenant_id", "=", "environment_keys.tenant_id")
        .onRef("environments.project_name", "=", "environment_keys.project_name")
        .onRef("environments.name", "=", "environment_keys.env_name"),
    )
    .innerJoin("environment_acl", (join) =>
      join
        .onRef("environment_acl.tenant_id", "=", "environment_keys.tenant_id")
        .onRef("environment_acl.project_name", "=", "environment_keys.project_name")
        .onRef("environment_acl.env_name", "=", "environment_keys.env_name")
        .onRef("environment_acl.username", "=", "environment_keys.username"),
    )
    .select([
      "environments.name",
      "environments.updated_at",
      "environment_acl.level",
      "environment_acl.caps",
      "environment_keys.wrapped_env_dek",
      "environments.rotate_pending",
      "environments.key_version",
    ])
    .where("environment_keys.tenant_id", "=", tenantId)
    .where("environment_keys.project_name", "=", projectName)
    .where("environment_keys.username", "=", username)
    .orderBy("environments.name", "asc")
    .execute();

  return rows.map((r) => ({
    name: r.name,
    updatedAt: r.updated_at,
    level: r.level as "read" | "write" | "manage",
    caps: r.caps,
    wrappedEnvDek: r.wrapped_env_dek,
    keyVersion: Number(r.key_version),
    rotatePending: Number(r.rotate_pending) === 1,
  }));
}

export async function upsertEnvironmentKey(
  db: Kysely<DbSchema>,
  row: EnvironmentKeyRow,
): Promise<void> {
  await db
    .insertInto("environment_keys")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["tenant_id", "project_name", "env_name", "username"]).doUpdateSet({
        wrapped_env_dek: row.wrapped_env_dek,
      }),
    )
    .execute();
}

export async function getEnvironmentKey(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
  username: string,
): Promise<EnvironmentKeyRow | undefined> {
  return db
    .selectFrom("environment_keys")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .where("username", "=", username)
    .executeTakeFirst();
}

export async function deleteEnvironmentKey(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
  username: string,
): Promise<void> {
  await db
    .deleteFrom("environment_keys")
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .where("username", "=", username)
    .execute();
}

export async function upsertEnvironmentAcl(
  db: Kysely<DbSchema>,
  row: EnvironmentAclRow,
): Promise<void> {
  await db
    .insertInto("environment_acl")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["tenant_id", "project_name", "env_name", "username"]).doUpdateSet({
        level: row.level,
        caps: row.caps,
      }),
    )
    .execute();
}

export async function getEnvironmentAcl(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
  username: string,
): Promise<EnvironmentAclRow | undefined> {
  return db
    .selectFrom("environment_acl")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .where("username", "=", username)
    .executeTakeFirst();
}

export async function listEnvironmentAcl(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
): Promise<EnvironmentAclRow[]> {
  return db
    .selectFrom("environment_acl")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .orderBy("username", "asc")
    .execute();
}

export async function deleteEnvironmentAcl(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
  username: string,
): Promise<void> {
  await db
    .deleteFrom("environment_acl")
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .where("username", "=", username)
    .execute();
}


/**
 * Replace an environment's key wraps (DEK rotation). Users not in `wraps` lose
 * access: their key and ACL rows are removed. Existing ACL levels are kept.
 */
export async function replaceEnvironmentKeys(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
  wraps: Array<{ username: string; wrappedEnvDek: string }>,
): Promise<void> {
  const keep = wraps.map((w) => w.username);
  await db
    .deleteFrom("environment_keys")
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .where("username", "not in", keep)
    .execute();
  await db
    .deleteFrom("environment_acl")
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", projectName)
    .where("env_name", "=", envName)
    .where("username", "not in", keep)
    .execute();
  for (const w of wraps) {
    await upsertEnvironmentKey(db, {
      tenant_id: tenantId,
      project_name: projectName,
      env_name: envName,
      username: w.username,
      wrapped_env_dek: w.wrappedEnvDek,
    });
  }
}

/** (project, env) pairs a user holds keys for within a tenant. */
export async function listEnvironmentKeysForUser(
  db: Kysely<DbSchema>,
  tenantId: string,
  username: string,
): Promise<Array<{ project: string; env: string }>> {
  const rows = await db
    .selectFrom("environment_keys")
    .select(["project_name", "env_name"])
    .where("tenant_id", "=", tenantId)
    .where("username", "=", username)
    .execute();
  return rows.map((r) => ({ project: r.project_name, env: r.env_name }));
}

/** Flag environments whose key is known to someone who just lost access. */
export async function markRotationPending(
  db: Kysely<DbSchema>,
  tenantId: string,
  items: Array<{ project: string; env: string }>,
): Promise<void> {
  for (const { project, env } of items) {
    await db
      .updateTable("environments")
      .set({ rotate_pending: 1 })
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", project)
      .where("name", "=", env)
      .execute();
  }
}

export async function clearRotationPending(
  db: Kysely<DbSchema>,
  tenantId: string,
  project: string,
  env: string,
): Promise<void> {
  await db
    .updateTable("environments")
    .set({ rotate_pending: 0 })
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", project)
    .where("name", "=", env)
    .execute();
}
