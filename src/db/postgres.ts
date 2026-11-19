import type { Kysely, PostgresPool } from "kysely";
import { PostgresDialect } from "kysely";
import type { Pool } from "@neondatabase/serverless";
import type { Database as DbSchema } from "./schema.js";
import { ensureSchema } from "./store.js";

const pools = new Map<string, Pool>();
const connections = new Map<string, Kysely<DbSchema>>();

/** Neon Pool is API-compatible with node-pg; Kysely's types still expect pg's connect(). */
function asKyselyPool(pool: Pool): PostgresPool {
  return pool as unknown as PostgresPool;
}

export function isPostgresTarget(target: string): boolean {
  return /^(postgres|postgresql):\/\//i.test(target.trim());
}

/**
 * Anything that looks like a URL but isn't Postgres is a mistake (a misspelled scheme such as
 * "postgressql://"). Without this it would be treated as a SQLite file path, and the whole
 * connection string, password included, would become a file name on disk.
 * The message names only the scheme, never the rest of the string.
 */
export function assertDbTarget(target: string): void {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(target.trim())?.[1];
  if (scheme && !isPostgresTarget(target)) {
    throw new Error(
      `DATABASE_URL has an unsupported scheme "${scheme}://". Use postgres:// or postgresql://, or a plain file path for SQLite.`,
    );
  }
}

/**
 * Prefer verify-full for Node/local; strip channel_binding (breaks some clients).
 */
export function normalizePostgresUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString.trim());
    url.searchParams.delete("channel_binding");
    const mode = url.searchParams.get("sslmode");
    if (mode === "require" || mode === "prefer" || mode === "verify-ca") {
      url.searchParams.set("sslmode", "verify-full");
    }
    return url.toString();
  } catch {
    return connectionString.trim();
  }
}

/**
 * Node server entry. Uses node-postgres over plain TCP so a local Postgres
 * (e.g. docker compose) works; the Neon WebSocket driver is Worker-only.
 */
export async function openPostgres(
  connectionString: string,
  options?: { max?: number },
): Promise<Kysely<DbSchema>> {
  const key = normalizePostgresUrl(connectionString);
  const existing = connections.get(key);
  if (existing) return existing;

  const [{ Kysely: KyselyCtor }, { default: pg }] = await Promise.all([
    import("kysely"),
    import("pg"),
  ]);
  let pool = pools.get(key);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: key,
      max: options?.max ?? 5,
    }) as unknown as Pool;
    pools.set(key, pool);
  }

  const db = new KyselyCtor<DbSchema>({
    dialect: new PostgresDialect({ pool: asKyselyPool(pool) }),
  });

  await ensureSchema(db);
  connections.set(key, db);
  return db;
}

/** Open with an existing Pool (e.g. request-scoped Worker pool). */
export async function openPostgresWithPool(
  cacheKey: string,
  pool: Pool,
): Promise<Kysely<DbSchema>> {
  const existing = connections.get(cacheKey);
  if (existing) return existing;

  const { Kysely: KyselyCtor } = await import("kysely");
  const db = new KyselyCtor<DbSchema>({
    dialect: new PostgresDialect({ pool: asKyselyPool(pool) }),
  });
  await ensureSchema(db);
  connections.set(cacheKey, db);
  pools.set(cacheKey, pool);
  return db;
}

export type { Pool };
