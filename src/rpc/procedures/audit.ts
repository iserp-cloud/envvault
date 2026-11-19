import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { macOf } from "../../audit.js";
import { listAudit } from "../../db/store.js";
import { AuthedContext, authed, dbOf, requireActiveMember, requireAdmin, requireHuman } from "../base.js";

const PageInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  /** Pagination cursor: only events strictly older than this timestamp. */
  before: z.string().optional(),
});

function present(rows: Awaited<ReturnType<typeof listAudit>>) {
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    action: r.action,
    tenantId: r.tenant_id,
    target: r.target,
    detail: r.detail,
    ip: r.ip,
  }));
}

/** Everything on the server (instance administrators). */
export const adminAuditList = authed
  .input(PageInput.extend({ actor: z.string().trim().optional(), tenantId: z.string().optional() }))
  .handler(async ({ input, context }) => {
    requireAdmin((context as AuthedContext).auth);
    return present(await listAudit(dbOf(context), input));
  });

/** One workspace's activity (its owners and admins). */
export const tenantsAudit = authed
  .input(PageInput.extend({ tenantId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const m = await requireActiveMember(dbOf(context), input.tenantId, username);
    if (m.role !== "owner" && m.role !== "admin") {
      throw new ORPCError("FORBIDDEN", { message: "Only owners and admins can view activity" });
    }
    return present(await listAudit(dbOf(context), input));
  });

/**
 * Re-check the MAC on recent audit rows. A row that fails was edited after it was
 * written by someone without the server's pepper; `unsigned` rows predate signing.
 * (Deleted rows are not detectable — ship logs off-box for that.)
 */
export const adminAuditVerify = authed.handler(async ({ context }) => {
  requireAdmin((context as AuthedContext).auth);
  const rows = await listAudit(dbOf(context), { limit: 5000 });
  let invalid = 0;
  let unsigned = 0;
  for (const r of rows) {
    if (!r.mac) unsigned++;
    else if (r.mac !== macOf(r)) invalid++;
  }
  return { checked: rows.length, invalid, unsigned };
});
