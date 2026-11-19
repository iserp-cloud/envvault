import { logError } from "./log.js";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database as DbSchema } from "./db/schema.js";
import { insertAudit, purgeAuditBefore } from "./db/store.js";
import { auditMac } from "./auth-proof.js";
import { clientIp } from "./ratelimit.js";
import type { AppContext } from "./rpc/context.js";

export type AuditEvent = {
  actor: string;
  action: string;
  tenantId?: string | null;
  target?: string;
  detail?: string;
};

function retentionDays(): number {
  const n = Number(process.env.ENVVAULT_AUDIT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 365;
}

/**
 * Record an activity event. Never throws and never blocks a request on failure;
 * values are never logged, only who did what to which resource.
 */
export async function recordAudit(
  ctx: Pick<AppContext, "db" | "headers" | "remoteAddress" | "trustCloudflare">,
  event: AuditEvent,
): Promise<void> {
  try {
    const now = new Date();
    const row = {
      id: randomUUID(),
      at: now.toISOString(),
      actor: event.actor,
      action: event.action,
      tenant_id: event.tenantId ?? null,
      target: (event.target ?? "").slice(0, 200),
      detail: (event.detail ?? "").slice(0, 300),
      ip: clientIp(ctx).slice(0, 64),
    };
    await insertAudit(ctx.db, { ...row, mac: macOf(row) });
    // Opportunistic retention, so no cron is needed.
    if (Math.random() < 0.01) {
      const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000).toISOString();
      await purgeAuditBefore(ctx.db, cutoff);
    }
  } catch (err) {
    logError("audit", err);
  }
}

export function macOf(r: {
  id: string;
  at: string;
  actor: string;
  action: string;
  tenant_id: string | null;
  target: string;
  detail: string;
  ip: string;
}): string {
  return auditMac([r.id, r.at, r.actor, r.action, r.tenant_id ?? "", r.target, r.detail, r.ip]);
}
