import { ORPCError } from "@orpc/server";
import { sql, type Kysely } from "kysely";
import type { Database as DbSchema } from "./db/schema.js";
import { getHeader, type AppContext, type HeadersLike } from "./rpc/context.js";

/**
 * Number of reverse proxies in front of the hub whose `X-Forwarded-For` entries we
 * trust (ENVVAULT_TRUSTED_PROXIES). 0 (default) ignores the header entirely, so a
 * client can't forge its address. On Kubernetes behind one ingress, set it to 1.
 */
export function trustedProxyHops(): number {
  const n = Number(process.env.ENVVAULT_TRUSTED_PROXIES);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10) : 0;
}

/** The caller's address, as far as we can trust it. */
export function clientIp(ctx: Pick<AppContext, "headers" | "remoteAddress" | "trustCloudflare">): string {
  if (ctx.trustCloudflare) {
    const cf = getHeader(ctx.headers as HeadersLike, "cf-connecting-ip");
    if (cf) return cf.trim();
  }
  const hops = trustedProxyHops();
  if (hops > 0) {
    const xff = getHeader(ctx.headers as HeadersLike, "x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
      // The proxy nearest us appends the real client as the Nth entry from the right.
      const picked = parts[parts.length - hops];
      if (picked) return picked;
    }
  }
  return ctx.remoteAddress ?? "unknown";
}

type Limit = { limit: number; windowMs: number };

async function hit(db: Kysely<DbSchema>, key: string, windowMs: number): Promise<number> {
  const now = new Date();
  const nowIso = now.toISOString();
  const resetAt = new Date(now.getTime() + windowMs).toISOString();
  // One atomic statement, so concurrent requests on any replica count correctly.
  const result = await sql<{ count: number | string }>`
    INSERT INTO rate_limits (key, count, reset_at) VALUES (${key}, 1, ${resetAt})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at <= ${nowIso} THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at <= ${nowIso} THEN ${resetAt} ELSE rate_limits.reset_at END
    RETURNING count
  `.execute(db);
  // Opportunistic cleanup so the table stays small.
  if (Math.random() < 0.02) {
    await db.deleteFrom("rate_limits").where("reset_at", "<", nowIso).execute();
  }
  return Number(result.rows[0]?.count ?? 1);
}

function tooMany(): never {
  throw new ORPCError("TOO_MANY_REQUESTS", { message: "Too many attempts. Try again later." });
}

/** Count one attempt against `key`; throws once it exceeds the limit. Shared across replicas. */
export async function rateLimit(db: Kysely<DbSchema>, key: string, opts: Limit): Promise<void> {
  if ((await hit(db, key, opts.windowMs)) > opts.limit) tooMany();
}

/** Throw if `key` has already reached its limit (does not count an attempt). */
export async function assertNotThrottled(db: Kysely<DbSchema>, key: string, limit: number): Promise<void> {
  const row = await db
    .selectFrom("rate_limits")
    .select(["count", "reset_at"])
    .where("key", "=", key)
    .executeTakeFirst();
  if (row && row.reset_at > new Date().toISOString() && Number(row.count) >= limit) tooMany();
}

/** Record a failed attempt against `key` (e.g. per account, across all IPs). */
export async function recordFailure(db: Kysely<DbSchema>, key: string, windowMs: number): Promise<void> {
  await hit(db, key, windowMs);
}

export async function clearFailures(db: Kysely<DbSchema>, key: string): Promise<void> {
  await db.deleteFrom("rate_limits").where("key", "=", key).execute();
}
