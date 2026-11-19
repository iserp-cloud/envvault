import { logError } from "../log.js";
import { ORPCError, os } from "@orpc/server";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ACL_CAPS, ACL_LEVELS, hasCap, levelAtLeast, type AclCap } from "@envvault/shared";
import type { Database as DbSchema } from "../db/schema.js";
import {
  getEnvironmentAcl,
  getEnvironmentKey,
  getTenantMember,
  listActiveAdminsAndOwner,
  listTenantMembers,
} from "../db/store.js";
import { clientIp } from "../ratelimit.js";
import { hashSessionToken } from "../security.js";
import { getBearerToken, getHeader, type AppContext } from "./context.js";
import { resolveAuth, type Auth } from "./runtime.js";

/** Ciphertext envelope produced by the client (see @envvault/shared zk.ts). */
export const SealedBoxSchema = z.object({
  v: z.literal(1),
  iv: z.string().min(8).max(32),
  ct: z.string().min(8).max(2_000_000),
});

export const KdfSchema = z.union([
  z.object({
    alg: z.literal("argon2id"),
    m: z.number().int(),
    t: z.number().int(),
    p: z.number().int(),
  }),
  z.object({ alg: z.literal("pbkdf2-sha256"), iterations: z.number().int() }),
]);

export const AclLevelSchema = z.enum(ACL_LEVELS);
export const AclCapSchema = z.enum(ACL_CAPS);

export type AclLevel = z.infer<typeof AclLevelSchema>;
export type AuthedContext = AppContext & { auth: Auth };

export const base = os.$context<AppContext>();

/** Who/what is calling, recorded on new sessions so users can recognise their devices. */
export function reqMeta(context: AppContext): { ip: string; userAgent: string } {
  return {
    ip: clientIp(context),
    userAgent: getHeader(context.headers, "user-agent") ?? "",
  };
}

export function dbOf(context: AppContext): Kysely<DbSchema> {
  return context.db;
}

export const authed = base.use(async ({ context, next }) => {
  const token = getBearerToken(context.headers);
  const auth = await resolveAuth(context.db, token);
  if (!auth) {
    throw new ORPCError("UNAUTHORIZED", {
      message: token ? "Invalid auth token" : "Missing auth token",
    });
  }
  return next({
    context: {
      auth: { ...auth, sessionHash: hashSessionToken(token!) },
    } satisfies Pick<AuthedContext, "auth">,
  });
});

export function requireUsername(auth: Auth): string {
  return auth.username;
}

/** Machine (service-token) accounts may read/write secrets they're granted, nothing else. */
export function requireHuman(auth: Auth): string {
  if (auth.kind !== "user") {
    throw new ORPCError("FORBIDDEN", { message: "Not available to service accounts" });
  }
  return auth.username;
}

export function requireAdmin(auth: Auth): string {
  if (auth.role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "Administrator access required" });
  }
  return auth.username;
}

export function aclSatisfies(level: AclLevel, minLevel: AclLevel): boolean {
  return levelAtLeast(level, minLevel);
}

export async function requireActiveMember(
  db: Kysely<DbSchema>,
  tenantId: string,
  username: string,
) {
  const m = await getTenantMember(db, tenantId, username);
  if (!m || m.status !== "active") {
    throw new ORPCError("FORBIDDEN", { message: "Not a member of this tenant" });
  }
  return m;
}

/** Ensure every keyWrap username is an active tenant member (normalized). */
export async function assertValidKeyWraps(
  db: Kysely<DbSchema>,
  tenantId: string,
  wraps: Array<{ username: string; wrappedEnvDek: string }>,
  required: { owner: string; creator: string },
): Promise<Array<{ username: string; wrappedEnvDek: string }>> {
  const normalized = wraps.map((w) => ({
    username: w.username.trim().toLowerCase(),
    wrappedEnvDek: w.wrappedEnvDek,
  }));
  const wrapUsers = new Set(normalized.map((w) => w.username));
  if (!wrapUsers.has(required.owner)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "keyWraps must include the tenant owner",
    });
  }
  if (!wrapUsers.has(required.creator)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "keyWraps must include the creator",
    });
  }
  // New environments are keyed only for the owner, admins and the creator, so a creator can't
  // pull arbitrary members into a brand-new environment in one step. Anyone else is granted
  // access explicitly afterwards (by someone with the `share` permission, at no more than their own access).
  const allowed = new Set(await listActiveAdminsAndOwner(db, tenantId));
  allowed.add(required.creator);
  for (const name of wrapUsers) {
    if (!allowed.has(name)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `keyWraps may only include the owner, admins and you ("${name}" must be granted access separately)`,
      });
    }
  }
  const members = new Map((await listTenantMembers(db, tenantId)).map((m) => [m.username, m]));
  for (const name of wrapUsers) {
    const m = members.get(name);
    if (!m || m.status !== "active") {
      throw new ORPCError("BAD_REQUEST", {
        message: `keyWraps user "${name}" must be an active tenant member`,
      });
    }
  }
  return normalized;
}

export async function requireEnvironmentAccess(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  envName: string,
  username: string,
  minLevel: AclLevel,
  /** A capability the grant must carry (any one of them, if several are listed). */
  cap?: AclCap | readonly AclCap[],
) {
  await requireActiveMember(db, tenantId, username);

  const [key, acl] = await Promise.all([
    getEnvironmentKey(db, tenantId, projectName, envName, username),
    getEnvironmentAcl(db, tenantId, projectName, envName, username),
  ]);
  if (!key || !acl) {
    throw new ORPCError("FORBIDDEN", { message: "No access to this environment" });
  }
  if (!aclSatisfies(acl.level, minLevel)) {
    throw new ORPCError("FORBIDDEN", { message: `Requires ${minLevel} access` });
  }
  if (cap) {
    const wanted = typeof cap === "string" ? [cap] : cap;
    if (!wanted.some((c) => hasCap(acl.level, acl.caps, c))) {
      throw new ORPCError("FORBIDDEN", {
        message: `Requires the "${wanted.join('" or "')}" permission on this environment`,
      });
    }
  }
  return { key, acl };
}

export function sessionFields(result: {
  sessionToken: string;
  username: string;
  publicKey: string;
  wrappedPrivateKey: unknown;
  personalTenantId: string;
  role: "admin" | "member";
}) {
  return {
    ok: true as const,
    token: result.sessionToken,
    username: result.username,
    publicKey: result.publicKey,
    wrappedPrivateKey: result.wrappedPrivateKey as z.infer<typeof SealedBoxSchema>,
    personalTenantId: result.personalTenantId,
    role: result.role,
  };
}

export function toOrpcError(
  err: unknown,
  fallbackCode:
    | "INTERNAL_SERVER_ERROR"
    | "FORBIDDEN"
    | "BAD_REQUEST" = "INTERNAL_SERVER_ERROR",
  fallbackMessage = "Request failed",
): never {
  if (err instanceof ORPCError) throw err;
  // Never echo internal error text (database, driver) to the caller.
  logError("rpc", err);
  throw new ORPCError(fallbackCode, { message: fallbackMessage });
}
