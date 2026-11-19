import { type Kysely } from "kysely";
import type { Database as DbSchema, InviteRow } from "./schema.js";

export async function createInvite(db: Kysely<DbSchema>, row: InviteRow): Promise<void> {
  await db.insertInto("invites").values(row).execute();
}

export async function getInviteByTokenHash(
  db: Kysely<DbSchema>,
  tokenHash: string,
): Promise<InviteRow | undefined> {
  return db
    .selectFrom("invites")
    .selectAll()
    .where("token_hash", "=", tokenHash)
    .executeTakeFirst();
}

export async function listInvites(db: Kysely<DbSchema>): Promise<InviteRow[]> {
  return db.selectFrom("invites").selectAll().orderBy("created_at", "desc").limit(200).execute();
}

/**
 * Atomically claim an invite. Returns false if it was already used, revoked or
 * expired, so two concurrent signups can never share one invite.
 */
export async function claimInvite(
  db: Kysely<DbSchema>,
  id: string,
  username: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .updateTable("invites")
    .set({ used_at: now, used_by: username })
    .where("id", "=", id)
    .where("used_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

export async function revokeInvite(
  db: Kysely<DbSchema>,
  id: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .updateTable("invites")
    .set({ revoked_at: now })
    .where("id", "=", id)
    .where("used_at", "is", null)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}
