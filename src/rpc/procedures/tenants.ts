import { ORPCError } from "@orpc/server";
import { recordAudit } from "../../audit.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import {
  listEnvironmentKeysForUser,
  markRotationPending,
  countOwnedOrgs,
  createTenant,
  deleteTenant,
  getTenant,
  getTenantMember,
  getUser,
  isHandleTaken,
  listActiveAdminsAndOwner,
  listPendingInvites,
  listTenantMembers,
  listTenantsForUser,
  removeTenantMember,
  upsertTenantMember,
} from "../../db/store.js";
import { MAX_OWNED_ORGS, normalizeSlug } from "@envvault/shared";
import { normalizeUsername } from "../runtime.js";
import {
  AuthedContext,
  authed,
  dbOf,
  requireActiveMember,
  requireHuman,
  requireUsername,
} from "../base.js";

export const tenantsList = authed.handler(async ({ context }) => {
  const username = requireUsername((context as AuthedContext).auth);
  const tenants = await listTenantsForUser(dbOf(context), username);
  return tenants.map((t) => ({
    id: t.id,
    slug: t.slug,
    name: t.kind === "personal" ? "Personal" : t.name,
    ownerUsername: t.owner_username,
    createdAt: t.created_at,
    role: t.role,
    kind: t.kind,
  }));
});

export const tenantsInvites = authed.handler(async ({ context }) => {
  const username = requireUsername((context as AuthedContext).auth);
  const invites = await listPendingInvites(dbOf(context), username);
  return invites.map((t) => ({
    id: t.id,
    slug: t.slug,
    name: t.name,
    ownerUsername: t.owner_username,
    createdAt: t.created_at,
    role: t.role,
    kind: "org" as const,
  }));
});

export const tenantsCreate = authed
  .input(z.object({ name: z.string().trim().min(1) }))
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);

    let slug: string;
    try {
      slug = normalizeSlug(input.name, "Organization name");
    } catch (err) {
      throw new ORPCError("BAD_REQUEST", {
        message: err instanceof Error ? err.message : "Invalid organization name",
      });
    }

    if (await countOwnedOrgs(db, username) >= MAX_OWNED_ORGS) {
      throw new ORPCError("FORBIDDEN", {
        message: `You can own at most ${MAX_OWNED_ORGS} organizations`,
      });
    }

    if (await isHandleTaken(db, slug)) {
      throw new ORPCError("CONFLICT", {
        message: "That name is already taken by a user or organization",
      });
    }

    const id = `t_${randomBytes(10).toString("base64url")}`;
    const now = new Date().toISOString();
    try {
      await createTenant(db, {
        id,
        slug,
        name: slug,
        owner_username: username,
        kind: "org",
        created_at: now,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(message)) {
        throw new ORPCError("CONFLICT", {
          message: "That name is already taken by a user or organization",
        });
      }
      throw err;
    }
    await upsertTenantMember(db, {
      tenant_id: id,
      username,
      role: "owner",
      status: "active",
    });
    await recordAudit(context, { actor: username, action: "workspace.create", tenantId: id, target: slug });
    return {
      id,
      slug,
      name: slug,
      ownerUsername: username,
      createdAt: now,
      kind: "org" as const,
    };
  });

export const tenantsMembers = authed
  .input(z.object({ tenantId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const username = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    await requireActiveMember(db, input.tenantId, username);
    const members = await listTenantMembers(db, input.tenantId);
    // Machine accounts have their own screen (Settings → Service tokens).
    const users = await Promise.all(members.map((m) => getUser(db, m.username)));
    return members.filter((_, i) => users[i]?.kind !== "service").map((m) => ({
      username: m.username,
      role: m.role,
      status: m.status,
    }));
  });

export const tenantsInvite = authed
  .input(
    z.object({
      tenantId: z.string().min(1),
      username: z.string().trim().min(1),
      role: z.enum(["admin", "member"]).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const actor = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    const membership = await requireActiveMember(db, input.tenantId, actor);
    if (membership.role !== "owner" && membership.role !== "admin") {
      throw new ORPCError("FORBIDDEN", { message: "Only owners/admins can invite" });
    }

    const role = input.role ?? "member";
    if (role === "admin" && membership.role !== "owner") {
      throw new ORPCError("FORBIDDEN", {
        message: "Only the organization owner can invite admins",
      });
    }

    const tenant = await getTenant(db, input.tenantId);
    if (!tenant || tenant.kind === "personal") {
      throw new ORPCError("FORBIDDEN", {
        message: "Personal vaults cannot have members — create an organization instead",
      });
    }

    let target: string;
    try {
      target = normalizeUsername(input.username);
    } catch (err) {
      throw new ORPCError("BAD_REQUEST", {
        message: err instanceof Error ? err.message : "Invalid username",
      });
    }

    const user = await getUser(db, target);
    if (!user || !user.public_key) {
      throw new ORPCError("NOT_FOUND", { message: "User not found" });
    }

    const existing = await getTenantMember(db, input.tenantId, target);
    if (existing?.status === "active") {
      throw new ORPCError("CONFLICT", { message: "User is already a member" });
    }
    if (existing?.status === "pending") {
      throw new ORPCError("CONFLICT", { message: "Invite already pending" });
    }

    await upsertTenantMember(db, {
      tenant_id: input.tenantId,
      username: target,
      role,
      status: "pending",
    });
    await recordAudit(context, { actor, action: "member.invite", tenantId: input.tenantId, target, detail: role });
    return { ok: true as const, username: target };
  });

export const tenantsAcceptInvite = authed
  .input(z.object({ tenantId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const username = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    const m = await getTenantMember(db, input.tenantId, username);
    if (!m || m.status !== "pending") {
      throw new ORPCError("NOT_FOUND", { message: "No pending invite" });
    }
    await upsertTenantMember(db, { ...m, status: "active" });
    await recordAudit(context, { actor: username, action: "member.accept", tenantId: input.tenantId, target: username });
    return { ok: true as const };
  });

export const tenantsDeclineInvite = authed
  .input(z.object({ tenantId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const username = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    const m = await getTenantMember(db, input.tenantId, username);
    if (!m || m.status !== "pending") {
      throw new ORPCError("NOT_FOUND", { message: "No pending invite" });
    }
    await removeTenantMember(db, input.tenantId, username);
    return { ok: true as const };
  });

/** Cancel a pending invite or remove an active member (and their project keys). */
export const tenantsRemoveMember = authed
  .input(
    z.object({
      tenantId: z.string().min(1),
      username: z.string().trim().min(1),
    }),
  )
  .handler(async ({ input, context }) => {
    const actor = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    const membership = await requireActiveMember(db, input.tenantId, actor);
    if (membership.role !== "owner" && membership.role !== "admin") {
      throw new ORPCError("FORBIDDEN", {
        message: "Only owners/admins can revoke invites or remove members",
      });
    }

    const tenant = await getTenant(db, input.tenantId);
    if (!tenant || tenant.kind === "personal") {
      throw new ORPCError("FORBIDDEN", {
        message: "Cannot change membership on a personal vault",
      });
    }

    let target: string;
    try {
      target = normalizeUsername(input.username);
    } catch (err) {
      throw new ORPCError("BAD_REQUEST", {
        message: err instanceof Error ? err.message : "Invalid username",
      });
    }

    if (target === tenant.owner_username) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Cannot remove the organization owner",
      });
    }
    if (target === actor) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Cannot remove yourself — leave the organization instead",
      });
    }

    const existing = await getTenantMember(db, input.tenantId, target);
    if (!existing) {
      throw new ORPCError("NOT_FOUND", { message: "Member or invite not found" });
    }
    if ((await getUser(db, target))?.kind === "service") {
      throw new ORPCError("BAD_REQUEST", {
        message: "Revoke service accounts from Settings → Service tokens",
      });
    }

    // Admins may only revoke invites / remove regular members, not other admins
    if (membership.role === "admin" && existing.role === "admin") {
      throw new ORPCError("FORBIDDEN", {
        message: "Only the owner can remove an admin",
      });
    }

    // Capture what they could read before their keys are removed, so the client
    // can rotate those environments' keys (a removed member still knows the old DEK).
    const affected = await listEnvironmentKeysForUser(db, input.tenantId, target);
    // Flag until a manager rotates, so a failed or skipped rotation can't be forgotten.
    await markRotationPending(db, input.tenantId, affected);
    await removeTenantMember(db, input.tenantId, target);
    await recordAudit(context, { actor, action: existing.status === "pending" ? "member.invite_revoked" : "member.remove", tenantId: input.tenantId, target });
    return {
      ok: true as const,
      username: target,
      wasPending: existing.status === "pending",
      rotate: affected,
    };
  });

export const tenantsDelete = authed
  .input(z.object({ tenantId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const actor = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    const tenant = await getTenant(db, input.tenantId);
    if (!tenant) {
      throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
    }
    if (tenant.kind === "personal") {
      throw new ORPCError("FORBIDDEN", {
        message: "Personal vaults cannot be deleted",
      });
    }
    if (tenant.owner_username !== actor) {
      throw new ORPCError("FORBIDDEN", {
        message: "Only the organization owner can delete it",
      });
    }

    await deleteTenant(db, input.tenantId);
    await recordAudit(context, { actor, action: "workspace.delete", tenantId: input.tenantId, target: tenant.slug });
    return { ok: true as const, id: input.tenantId };
  });

export const tenantsKeyRecipients = authed
  .input(z.object({ tenantId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const username = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    await requireActiveMember(db, input.tenantId, username);
    const names = new Set(await listActiveAdminsAndOwner(db, input.tenantId));
    names.add(username);
    const recipients = [];
    for (const name of names) {
      const u = await getUser(db, name);
      if (u?.public_key) {
        recipients.push({ username: u.username, publicKey: u.public_key });
      }
    }
    return recipients;
  });
