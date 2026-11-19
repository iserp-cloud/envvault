import { type Kysely, sql } from "kysely";
import type { Database as DbSchema } from "./schema.js";
import { getSetting, setSetting } from "./settings.js";

/** Bump when the schema below changes. Skips DDL when current. */
export const SCHEMA_VERSION = "zk-6";

export async function ensureSchema(db: Kysely<DbSchema>): Promise<void> {
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
