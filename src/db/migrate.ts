import { type Kysely, sql } from "kysely";
import type { Database as DbSchema } from "./schema.js";
import { getSetting, setSetting } from "./settings.js";

/** Bump when the schema below changes. Skips DDL when current. */
export const SCHEMA_VERSION = "zk-6";

export async function ensureSchema(db: Kysely<DbSchema>): Promise<void> {
  await ensureSchemaCore(db);
  await ensureK8sTables(db);
}

/** Kubernetes links: new tables only, so they are added to a database already at the current version. */
async function ensureK8sTables(db: Kysely<DbSchema>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS k8s_links (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      env_name TEXT NOT NULL,
      cluster TEXT NOT NULL,
      namespace TEXT NOT NULL,
      secret_name TEXT NOT NULL,
      direction TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      status_message TEXT NOT NULL DEFAULT '',
      key_count INTEGER NOT NULL DEFAULT 0,
      reported_at TEXT NOT NULL DEFAULT '',
      adopt INTEGER NOT NULL DEFAULT 0
    )
  `.execute(db);
  // One writer per Secret: a Secret is the target of one link, which also stops a pull and a push from looping.
  await addColumn(db, "k8s_links", "adopt", "INTEGER NOT NULL DEFAULT 0");
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS k8s_links_secret_idx ON k8s_links (cluster, namespace, secret_name)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS k8s_links_env_idx ON k8s_links (tenant_id, project_name, env_name)`.execute(db);
  await ensureOnePushPerEnvironment(db);
  await sql`
    CREATE TABLE IF NOT EXISTS k8s_clusters (
      cluster TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '',
      namespaces TEXT NOT NULL DEFAULT '[]',
      token_expires_at TEXT NOT NULL DEFAULT ''
    )
  `.execute(db);
}

async function ensureSchemaCore(db: Kysely<DbSchema>): Promise<void> {
  try {
    if ((await getSetting(db, "schema_version")) === SCHEMA_VERSION) return;
  } catch {
    /* settings table may not exist yet */
  }

  await assertNotLegacy(db);

  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL DEFAULT 'user',
      auth_salt TEXT NOT NULL,
      auth_hash TEXT NOT NULL,
      kdf TEXT NOT NULL,
      public_key TEXT NOT NULL,
      wrapped_private_key TEXT NOT NULL,
      recovery_salt TEXT NOT NULL DEFAULT '',
      recovery_hash TEXT NOT NULL DEFAULT '',
      recovery_wrapped_private_key TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      service_tenant TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS users_service_idx ON users (service_tenant)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS sessions_username_idx ON sessions (username)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      tenant_id TEXT,
      tenant_role TEXT,
      used_at TEXT,
      used_by TEXT,
      revoked_at TEXT
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_username TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'org',
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_idx ON tenants (slug)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS tenant_members (
      tenant_id TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (tenant_id, username)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS tenant_members_user_idx ON tenant_members (username)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, name)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS environments (
      tenant_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      name TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      rotate_pending INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, project_name, name)
    )
  `.execute(db);

  // Columns added after the first release of this table (CREATE IF NOT EXISTS won't add them).
  await addColumn(db, "environments", "version", "INTEGER NOT NULL DEFAULT 1");
  await addColumn(db, "environments", "updated_by", "TEXT NOT NULL DEFAULT ''");
  await addColumn(db, "environments", "note", "TEXT NOT NULL DEFAULT ''");
  await addColumn(db, "environments", "key_version", "INTEGER NOT NULL DEFAULT 1");

  await sql`
    CREATE TABLE IF NOT EXISTS environment_versions (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      env_name TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT ''
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS environment_versions_env_idx
    ON environment_versions (tenant_id, project_name, env_name, version)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS environment_keys (
      tenant_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      env_name TEXT NOT NULL,
      username TEXT NOT NULL,
      wrapped_env_dek TEXT NOT NULL,
      PRIMARY KEY (tenant_id, project_name, env_name, username)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS environment_keys_user_idx ON environment_keys (username)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS environment_acl (
      tenant_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      env_name TEXT NOT NULL,
      username TEXT NOT NULL,
      level TEXT NOT NULL,
      PRIMARY KEY (tenant_id, project_name, env_name, username)
    )
  `.execute(db);
  await addColumn(db, "environment_acl", "caps", "TEXT NOT NULL DEFAULT ''");

  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY NOT NULL,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      tenant_id TEXT,
      target TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      mac TEXT NOT NULL DEFAULT ''
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY NOT NULL,
      count INTEGER NOT NULL,
      reset_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log (at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS audit_tenant_idx ON audit_log (tenant_id, at)`.execute(db);

  await setSetting(db, "schema_version", SCHEMA_VERSION);
}

/** Add a column to an existing table if it isn't there yet (identifiers are fixed literals). */
async function addColumn(db: Kysely<DbSchema>, table: string, column: string, ddl: string): Promise<void> {
  try {
    await sql.raw(`SELECT ${column} FROM ${table} LIMIT 1`).execute(db);
  } catch {
    await sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).execute(db);
  }
}

/**
 * Databases created before zero-knowledge crypto hold server-decryptable data
 * and password hashes. They cannot be upgraded without the users' passwords.
 */
async function assertNotLegacy(db: Kysely<DbSchema>): Promise<void> {
  let legacy = false;
  for (const column of ["password_hash", "kdf_iterations"]) {
    try {
      await sql.raw(`SELECT ${column} FROM users LIMIT 1`).execute(db);
      legacy = true;
    } catch {
      /* no users table, or already the new shape */
    }
  }
  // A users table that exists but predates the current columns is also incompatible.
  try {
    await sql`SELECT 1 FROM users LIMIT 1`.execute(db);
    try {
      await sql`SELECT ip FROM sessions LIMIT 1`.execute(db);
    } catch {
      legacy = true;
    }
  } catch {
    /* fresh database */
  }
  if (legacy) {
    throw new Error(
      "This database was created by an older EnvVault (server-side encryption) and is not compatible with zero-knowledge mode. Point DATABASE_URL / ENVVAULT_DB at a new, empty database and re-create accounts.",
    );
  }
}

/**
 * One push link per environment, enforced by the database so two simultaneous requests cannot both
 * succeed. A database that already holds two pushes into one environment (made before the rule
 * existed) keeps them and starts anyway: the index is left out, a warning names the links, and the
 * rule still holds for new ones through the check in the link handler. Remove the extra links and the
 * index is made on the next start.
 */
async function ensureOnePushPerEnvironment(db: Kysely<DbSchema>): Promise<void> {
  const dup = await sql<{ tenant_id: string; project_name: string; env_name: string; links: string }>`
    SELECT tenant_id, project_name, env_name,
           group_concat(namespace || '/' || secret_name, ', ') AS links
    FROM k8s_links WHERE direction = 'push'
    GROUP BY tenant_id, project_name, env_name HAVING COUNT(*) > 1
  `.execute(db).catch(async () => {
    // Postgres has no group_concat.
    return sql<{ tenant_id: string; project_name: string; env_name: string; links: string }>`
      SELECT tenant_id, project_name, env_name,
             string_agg(namespace || '/' || secret_name, ', ') AS links
      FROM k8s_links WHERE direction = 'push'
      GROUP BY tenant_id, project_name, env_name HAVING COUNT(*) > 1
    `.execute(db);
  });
  if (dup.rows.length > 0) {
    for (const d of dup.rows) {
      console.warn(
        `WARNING: ${d.project_name}/${d.env_name} has several Secret -> Vault links (${d.links}); they overwrite each other's keys. ` +
          "Unlink all but one in the dashboard; the hub then enforces one push link per environment.",
      );
    }
    return;
  }
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS k8s_links_one_push_idx ON k8s_links (tenant_id, project_name, env_name) WHERE direction = 'push'`.execute(db);
}
