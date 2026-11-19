import { ORPCError } from "@orpc/server";
import { recordAudit } from "../../audit.js";
import { z } from "zod";
import { hashInviteToken, newInviteToken } from "../../auth-proof.js";
import {
  countActiveAdmins,
  createInvite,
  deleteSessionsForUser,
  getTenant,
  getTenantMember,
  getUser,
  listInvites,
  listUsers,
  revokeInvite,
  updateUser,
  withAdminLock,
} from "../../db/store.js";
import { AuthedContext, authed, dbOf, requireAdmin } from "../base.js";

const adminOnly = authed.use(({ context, next }) => {
  requireAdmin((context as AuthedContext).auth);
  return next();
});

export const adminUsersList = adminOnly.handler(async ({ context }) => {
  const users = await listUsers(dbOf(context));
  return users.map((u) => ({
    username: u.username,
    role: u.role,
    status: u.status,
    kind: u.kind,
    createdAt: u.created_at,
  }));
});

async function assertNotLastAdmin(
  db: ReturnType<typeof dbOf>,
  target: { role: string; status: string },
): Promise<void> {
  if (target.role === "admin" && target.status === "active") {
    if ((await countActiveAdmins(db)) <= 1) {
      throw new ORPCError("BAD_REQUEST", {
        message: "At least one active administrator must remain",
      });
    }
  }
}

export const adminUsersSetStatus = adminOnly
  .input(
    z.object({
      username: z.string().trim().min(1),
      status: z.enum(["active", "disabled"]),
    }),
  )
  .handler(async ({ input, context }) => {
    const actor = requireAdmin((context as AuthedContext).auth);
    const name = input.username.trim().toLowerCase();
    // Check and change under one lock, so two admins can't disable each other at once.
    const target = await withAdminLock(dbOf(context), async (trx) => {
      const found = await getUser(trx, name);
      if (!found) throw new ORPCError("NOT_FOUND", { message: "User not found" });
      if (input.status === "disabled") await assertNotLastAdmin(trx, found);
      await updateUser(trx, found.username, { status: input.status });
      // Disabling signs the user out everywhere immediately.
      if (input.status === "disabled") await deleteSessionsForUser(trx, found.username);
      return found;
    });
    await recordAudit(context, { actor, action: `user.${input.status === "disabled" ? "disable" : "enable"}`, target: target.username });
    return { ok: true as const };
  });

export const adminUsersSetRole = adminOnly
  .input(
    z.object({
      username: z.string().trim().min(1),
      role: z.enum(["admin", "member"]),
    }),
  )
  .handler(async ({ input, context }) => {
    const actor = requireAdmin((context as AuthedContext).auth);
    const name = input.username.trim().toLowerCase();
    const target = await withAdminLock(dbOf(context), async (trx) => {
      const found = await getUser(trx, name);
      if (!found) throw new ORPCError("NOT_FOUND", { message: "User not found" });
      if (input.role === "member") await assertNotLastAdmin(trx, found);
      await updateUser(trx, found.username, { role: input.role });
      return found;
    });
    await recordAudit(context, { actor, action: "user.role", target: target.username, detail: input.role });
    return { ok: true as const };
  });

export const adminInvitesCreate = adminOnly
  .input(
    z.object({
      expiresInHours: z.number().int().min(1).max(24 * 90).default(72),
      note: z.string().trim().max(120).default(""),
      /** Also invite the new user to this workspace (must be an org you own/admin). */
      tenantId: z.string().min(1).optional(),
      tenantRole: z.enum(["admin", "member"]).default("member"),
    }),
  )
  .handler(async ({ input, context }) => {
    const actor = requireAdmin((context as AuthedContext).auth);
    const db = dbOf(context);

    if (input.tenantId) {
      const tenant = await getTenant(db, input.tenantId);
      const member = await getTenantMember(db, input.tenantId, actor);
      if (
        !tenant ||
        tenant.kind !== "org" ||
        member?.status !== "active" ||
        (member.role !== "owner" && member.role !== "admin")
      ) {
        throw new ORPCError("FORBIDDEN", {
          message: "You must own or administer that workspace to invite people to it",
        });
      }
      if (input.tenantRole === "admin" && member.role !== "owner") {
        throw new ORPCError("FORBIDDEN", {
          message: "Only the workspace owner can invite admins",
        });
      }
    }

    const token = newInviteToken();
    const now = new Date();
    const id = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + input.expiresInHours * 3_600_000).toISOString();
    await createInvite(db, {
      id,
      token_hash: hashInviteToken(token),
      created_by: actor,
      created_at: now.toISOString(),
      expires_at: expiresAt,
      note: input.note,
      tenant_id: input.tenantId ?? null,
      tenant_role: input.tenantId ? input.tenantRole : null,
      used_at: null,
      used_by: null,
      revoked_at: null,
    });
    await recordAudit(context, { actor, action: "invite.create", tenantId: input.tenantId ?? null, target: input.note || id });
    // The token is shown once; only its hash is stored.
    return { id, token, expiresAt };
  });

export const adminInvitesList = adminOnly.handler(async ({ context }) => {
  const now = new Date().toISOString();
  const rows = await listInvites(dbOf(context));
  return rows.map((r) => ({
    id: r.id,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    tenantId: r.tenant_id,
    tenantRole: r.tenant_role,
    usedBy: r.used_by,
    usedAt: r.used_at,
    state: r.used_at
      ? ("used" as const)
      : r.revoked_at
        ? ("revoked" as const)
        : r.expires_at <= now
          ? ("expired" as const)
          : ("active" as const),
  }));
});

export const adminInvitesRevoke = adminOnly
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const ok = await revokeInvite(dbOf(context), input.id, new Date().toISOString());
    if (!ok) {
      throw new ORPCError("NOT_FOUND", { message: "Invite not found or already used" });
    }
    await recordAudit(context, { actor: requireAdmin((context as AuthedContext).auth), action: "invite.revoke", target: input.id });
    return { ok: true as const };
  });
