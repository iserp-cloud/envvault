import { type Kysely } from "kysely";
import type { Database as DbSchema, SessionRow, UserRow } from "./schema.js";
import { hashSessionToken, sessionExpiresAt } from "../security.js";

export async function countUsers(db: Kysely<DbSchema>): Promise<number> {
  const row = await db
    .selectFrom("users")
    .select(db.fn.countAll<number>().as("c"))
    .executeTakeFirst();
  return Number(row?.c ?? 0);
}

export async function getUser(
  db: Kysely<DbSchema>,
  username: string,
): Promise<UserRow | undefined> {
  return db
    .selectFrom("users")
    .selectAll()
    .where("username", "=", username)
    .executeTakeFirst();
}

export async function listUsers(db: Kysely<DbSchema>): Promise<UserRow[]> {
  return db.selectFrom("users").selectAll().orderBy("username", "asc").execute();
}

export async function countActiveAdmins(db: Kysely<DbSchema>): Promise<number> {
  const row = await db
    .selectFrom("users")
    .select(db.fn.countAll<number>().as("c"))
    .where("role", "=", "admin")
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(row?.c ?? 0);
}

export async function insertUser(db: Kysely<DbSchema>, user: UserRow): Promise<void> {
  await db.insertInto("users").values(user).execute();
}

export async function updateUser(
  db: Kysely<DbSchema>,
  username: string,
  patch: Partial<Omit<UserRow, "username" | "created_at">>,
): Promise<void> {
  await db.updateTable("users").set(patch).where("username", "=", username).execute();
}

/** Active sessions only; disabled accounts never resolve. */
export async function getUserBySessionToken(
  db: Kysely<DbSchema>,
  token: string,
): Promise<UserRow | undefined> {
  const tokenHash = hashSessionToken(token);
  const session = await db
    .selectFrom("sessions")
    .select(["username", "expires_at"])
    .where("token", "=", tokenHash)
    .executeTakeFirst();
  if (!session) return undefined;
  if (session.expires_at < new Date().toISOString()) {
    await db.deleteFrom("sessions").where("token", "=", tokenHash).execute();
    return undefined;
  }
  const user = await getUser(db, session.username);
  return user?.status === "active" ? user : undefined;
}

export async function createSession(
  db: Kysely<DbSchema>,
  username: string,
  token: string,
  expiresAt?: string,
  meta?: { ip?: string; userAgent?: string },
): Promise<void> {
  const now = new Date();
  const session: SessionRow = {
    token: hashSessionToken(token),
    username,
    created_at: now.toISOString(),
    expires_at: expiresAt ?? sessionExpiresAt(now),
    ip: (meta?.ip ?? "").slice(0, 64),
    user_agent: (meta?.userAgent ?? "").slice(0, 200),
  };
  await db.insertInto("sessions").values(session).execute();
  // Opportunistic cleanup, so expired rows don't pile up and no cron is needed.
  if (Math.random() < 0.05) await purgeExpiredSessions(db);
}

/** Revoke every login for a user (password change, disable). */
export async function deleteSessionsForUser(
  db: Kysely<DbSchema>,
  username: string,
): Promise<void> {
  await db.deleteFrom("sessions").where("username", "=", username).execute();
}

/** Drop expired sessions. Cheap; call opportunistically. */
export async function purgeExpiredSessions(db: Kysely<DbSchema>): Promise<void> {
  await db.deleteFrom("sessions").where("expires_at", "<", new Date().toISOString()).execute();
}

export async function listServiceAccounts(
  db: Kysely<DbSchema>,
  tenantId: string,
): Promise<UserRow[]> {
  return db
    .selectFrom("users")
    .selectAll()
    .where("kind", "=", "service")
    .where("service_tenant", "=", tenantId)
    .orderBy("created_at", "desc")
    .execute();
}

/** Latest session expiry for a user (service tokens), or null. */
export async function latestSessionExpiry(
  db: Kysely<DbSchema>,
  username: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("sessions")
    .select("expires_at")
    .where("username", "=", username)
    .orderBy("expires_at", "desc")
    .executeTakeFirst();
  return row?.expires_at ?? null;
}

export async function listSessionsForUser(
  db: Kysely<DbSchema>,
  username: string,
): Promise<SessionRow[]> {
  return db
    .selectFrom("sessions")
    .selectAll()
    .where("username", "=", username)
    .where("expires_at", ">", new Date().toISOString())
    .orderBy("created_at", "desc")
    .execute();
}

/** Revoke one session by its (public) id: the first 16 hex chars of the stored token hash. */
export async function revokeSessionById(
  db: Kysely<DbSchema>,
  username: string,
  id: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{16}$/.test(id)) return false;
  const rows = await db
    .selectFrom("sessions")
    .select("token")
    .where("username", "=", username)
    .execute();
  const match = rows.find((r) => r.token.startsWith(id));
  if (!match) return false;
  await db.deleteFrom("sessions").where("token", "=", match.token).execute();
  return true;
}

/** Sign out everywhere except the session identified by `keepHash`. */
export async function revokeOtherSessions(
  db: Kysely<DbSchema>,
  username: string,
  keepHash: string,
): Promise<void> {
  await db
    .deleteFrom("sessions")
    .where("username", "=", username)
    .where("token", "!=", keepHash)
    .execute();
}

/**
 * Run `fn` in a transaction that first takes a lock shared by every admin-count change,
 * so "at least one admin remains" can't be defeated by two concurrent requests.
 */
export async function withAdminLock<T>(
  db: Kysely<DbSchema>,
  fn: (trx: Kysely<DbSchema>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await trx
      .insertInto("settings")
      .values({ key: "admin_lock", value: "0" })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
    // Writing the row takes a row lock (Postgres) / the write lock (SQLite) until commit.
    await trx
      .updateTable("settings")
      .set({ value: String(Date.now()) })
      .where("key", "=", "admin_lock")
      .execute();
    return fn(trx);
  });
}

/** Distinct KDF parameter sets in use (JSON strings). */
export async function listDistinctKdfs(db: Kysely<DbSchema>): Promise<string[]> {
  const rows = await db.selectFrom("users").select("kdf").distinct().orderBy("kdf").execute();
  return rows.map((r) => r.kdf);
}
