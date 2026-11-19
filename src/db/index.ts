import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Kysely, SqliteDialect } from "kysely";
import type { Database as DbSchema } from "./schema.js";
import { ensureSchema, type StoredProject } from "./store.js";
import { assertDbTarget, isPostgresTarget, openPostgres } from "./postgres.js";

export type { StoredProject };
export {
  getStoredProject,
  upsertStoredProject,
  removeStoredProject,
  hasStoredProject,
  getSetting,
  setSetting,
  deleteSettings,
  ensureSchema,
} from "./store.js";
export { assertDbTarget, isPostgresTarget, openPostgres, openPostgresWithPool } from "./postgres.js";
export type { DbSchema };

const sqliteConnections = new Map<string, Kysely<DbSchema>>();

function ensureParentDir(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

async function openSqlite(dbPath: string): Promise<Kysely<DbSchema>> {
  const existing = sqliteConnections.get(dbPath);
  if (existing) {
    await ensureSchema(existing);
    return existing;
  }

  ensureParentDir(dbPath);
  // Loaded lazily so a Postgres-only deployment (Docker/K8s) doesn't need the native module.
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");

  const db = new Kysely<DbSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  });

  sqliteConnections.set(dbPath, db);
  await ensureSchema(db);
  return db;
}

/**
 * Open vault DB. `target` is either:
 * - a filesystem path → SQLite (local Node)
 * - a `postgres://` / `postgresql://` URL → Postgres
 */
export async function openDb(target: string): Promise<Kysely<DbSchema>> {
  assertDbTarget(target);
  if (isPostgresTarget(target)) {
    return openPostgres(target);
  }
  return openSqlite(target);
}
