import { type Kysely } from "kysely";
import type { AuditLogRow, Database as DbSchema } from "./schema.js";

export async function insertAudit(db: Kysely<DbSchema>, row: AuditLogRow): Promise<void> {
  await db.insertInto("audit_log").values(row).execute();
}

export async function listAudit(
  db: Kysely<DbSchema>,
  opts: { tenantId?: string; actor?: string; before?: string; limit: number },
): Promise<AuditLogRow[]> {
  let q = db.selectFrom("audit_log").selectAll().orderBy("at", "desc").limit(opts.limit);
  if (opts.tenantId) q = q.where("tenant_id", "=", opts.tenantId);
  if (opts.actor) q = q.where("actor", "=", opts.actor);
  if (opts.before) q = q.where("at", "<", opts.before);
  return q.execute();
}

export async function purgeAuditBefore(db: Kysely<DbSchema>, cutoff: string): Promise<void> {
  await db.deleteFrom("audit_log").where("at", "<", cutoff).execute();
}

/** True if `username` has signed in successfully from this address before. */
export async function hasLoginFromAddress(
  db: Kysely<DbSchema>,
  username: string,
  ip: string,
): Promise<boolean> {
  if (!ip || ip === "unknown") return false;
  const row = await db
    .selectFrom("audit_log")
    .select("id")
    .where("actor", "=", username)
    .where("action", "=", "account.login")
    .where("ip", "=", ip)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}
