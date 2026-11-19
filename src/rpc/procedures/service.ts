import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  latestSessionExpiry,
  listServiceAccounts,
} from "../../db/store.js";
import { createServiceAccount, revokeServiceAccount } from "../runtime.js";
import {
  AuthedContext,
  authed,
  dbOf,
  requireActiveMember,
  requireHuman,
} from "../base.js";

const TenantInput = z.object({ tenantId: z.string().min(1) });

async function requireManager(context: unknown, tenantId: string): Promise<string> {
  const ctx = context as AuthedContext;
  const username = requireHuman(ctx.auth);
  const m = await requireActiveMember(dbOf(ctx), tenantId, username);
  if (m.role !== "owner" && m.role !== "admin") {
    throw new ORPCError("FORBIDDEN", {
      message: "Only owners and admins can manage service tokens",
    });
  }
  return username;
}

/**
 * Create a machine account. The client generated the keypair, so only the public
 * key reaches the server; the private key travels inside the token string the
 * creator hands to CI. Environment access is granted separately (client-side wrap).
 */
export const serviceAccountsCreate = authed
  .input(
    TenantInput.extend({
      name: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9_-]{1,27}$/, "Name must be 2–28 chars: letters, numbers, _ or -"),
      publicKey: z.string().min(100).max(2000),
      expiresInDays: z.number().int().min(1).max(365).default(90),
    }),
  )
  .handler(async ({ input, context }) => {
    const actor = await requireManager(context, input.tenantId);
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
    try {
      const created = await createServiceAccount(dbOf(context), {
        name: input.name,
        tenantId: input.tenantId,
        publicKey: input.publicKey,
        createdBy: actor,
        expiresAt,
      });
      await recordAudit(context, {
        actor,
        action: "service.create",
        tenantId: input.tenantId,
        target: created.username,
        detail: `expires ${expiresAt.slice(0, 10)}`,
      });
      return { username: created.username, token: created.token, expiresAt };
    } catch (err) {
      if (err instanceof Error && /already taken/i.test(err.message)) {
        throw new ORPCError("CONFLICT", { message: "A service account with that name exists" });
      }
      if (err instanceof Error && /Username must|reserved/i.test(err.message)) {
        throw new ORPCError("BAD_REQUEST", { message: err.message });
      }
      throw err;
    }
  });

export const serviceAccountsList = authed.input(TenantInput).handler(async ({ input, context }) => {
  await requireManager(context, input.tenantId);
  const db = dbOf(context);
  const accounts = await listServiceAccounts(db, input.tenantId);
  return Promise.all(
    accounts.map(async (a) => ({
      username: a.username,
      createdBy: a.created_by,
      createdAt: a.created_at,
      status: a.status,
      expiresAt: await latestSessionExpiry(db, a.username),
    })),
  );
});

/** Returns the environments to rotate; the client must rotate them (the token holder knows the DEKs). */
export const serviceAccountsRevoke = authed
  .input(TenantInput.extend({ username: z.string().trim().min(1) }))
  .handler(async ({ input, context }) => {
    const actor = await requireManager(context, input.tenantId);
    try {
      const rotate = await revokeServiceAccount(
        dbOf(context),
        input.tenantId,
        input.username.trim().toLowerCase(),
      );
      await recordAudit(context, {
        actor,
        action: "service.revoke",
        tenantId: input.tenantId,
        target: input.username,
      });
      return { ok: true as const, rotate };
    } catch (err) {
      if (err instanceof Error && /not found/i.test(err.message)) {
        throw new ORPCError("NOT_FOUND", { message: err.message });
      }
      throw err;
    }
  });
