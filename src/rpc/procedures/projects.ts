import { deleteK8sLinksForProject } from "../../db/k8s.js";
import { ORPCError } from "@orpc/server";
import { recordAudit } from "../../audit.js";
import { z } from "zod";
import {
  canDeleteProject,
  getTenant,
  hasStoredProject,
  insertNewEnvironment,
  insertNewProject,
  listProjectsForUser,
  removeStoredProject,
  upsertEnvironmentAcl,
  upsertEnvironmentKey,
} from "../../db/store.js";
import { isUniqueViolation } from "../../db/errors.js";
import { DEFAULT_ENV_NAME } from "@envvault/shared";
import {
  AuthedContext,
  SealedBoxSchema,
  assertValidKeyWraps,
  authed,
  dbOf,
  requireActiveMember,
  requireHuman,
  requireUsername,
} from "../base.js";

/** No control characters or the AAD separator. */
const ProjectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\x00-\x1f|]+$/, "Project name contains invalid characters");

export const listProjectsProc = authed
  .input(z.object({ tenantId: z.string().min(1).optional() }).optional())
  .handler(async ({ input, context }) => {
    const username = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    const tenantId = input?.tenantId;
    if (tenantId) await requireActiveMember(db, tenantId, username);
    const rows = await listProjectsForUser(db, username, tenantId);

    // `level` is already the max across environments, so manage access needs no
    // extra ACL query; only tenant ownership needs a lookup per tenant.
    const ownerByTenant = new Map<string, boolean>();
    for (const id of new Set(rows.map((r) => r.tenantId))) {
      ownerByTenant.set(id, (await getTenant(db, id))?.owner_username === username);
    }
    return rows.map((r) => ({
      name: r.name,
      tenantId: r.tenantId,
      updatedAt: r.updatedAt,
      level: r.level,
      canManage: ownerByTenant.get(r.tenantId) === true || r.level === "manage",
    }));
  });

export const createProject = authed
  .input(
    z.object({
      tenantId: z.string().min(1),
      name: ProjectNameSchema,
      /** The default environment, sealed client-side with its DEK. */
      payload: SealedBoxSchema,
      keyWraps: z
        .array(
          z.object({
            username: z.string().min(1),
            wrappedEnvDek: z.string().min(1).max(4000),
          }),
        )
        .min(1)
        .max(500),
    }),
  )
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    const membership = await requireActiveMember(db, input.tenantId, username);
    if (membership.role === "member") {
      throw new ORPCError("FORBIDDEN", { message: "Members cannot create projects" });
    }
    if (await hasStoredProject(db, input.name, input.tenantId)) {
      throw new ORPCError("CONFLICT", { message: "Project already exists" });
    }
    const tenant = await getTenant(db, input.tenantId);
    if (!tenant) throw new ORPCError("NOT_FOUND", { message: "Tenant not found" });

    const keyWraps = await assertValidKeyWraps(db, input.tenantId, input.keyWraps, {
      owner: tenant.owner_username,
      creator: username,
    });

    const updatedAt = new Date().toISOString();
    // One transaction, and inserts that refuse a duplicate: two requests for the same name can't
    // interleave (one ciphertext with another request's keys), and a failure halfway leaves nothing behind.
    try {
      await db.transaction().execute(async (trx) => {
        await insertNewProject(trx, { tenantId: input.tenantId, name: input.name, updatedAt });
        await insertNewEnvironment(trx, {
          tenantId: input.tenantId,
          projectName: input.name,
          name: DEFAULT_ENV_NAME,
          updatedAt,
          payload: input.payload,
          updatedBy: username,
        });
        for (const wrap of keyWraps) {
          await upsertEnvironmentKey(trx, {
            tenant_id: input.tenantId,
            project_name: input.name,
            env_name: DEFAULT_ENV_NAME,
            username: wrap.username,
            wrapped_env_dek: wrap.wrappedEnvDek,
          });
          await upsertEnvironmentAcl(trx, {
            tenant_id: input.tenantId,
            project_name: input.name,
            env_name: DEFAULT_ENV_NAME,
            username: wrap.username,
            level: "manage",
            caps: "",
          });
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ORPCError("CONFLICT", { message: "Project already exists" });
      throw err;
    }

    await recordAudit(context, { actor: username, action: "project.create", tenantId: input.tenantId, target: input.name });
    return { name: input.name, tenantId: input.tenantId, updatedAt };
  });

export const deleteProjectProc = authed
  .input(z.object({ tenantId: z.string().min(1), name: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    await requireActiveMember(db, input.tenantId, username); // a pending invitee can't delete anything
    if (!(await canDeleteProject(db, input.tenantId, input.name, username))) {
      throw new ORPCError("FORBIDDEN", {
        message: "Deleting a project requires owner/admin access, or manage access on every environment",
      });
    }
    if (!(await removeStoredProject(db, input.name, input.tenantId))) {
      throw new ORPCError("NOT_FOUND", { message: "Project not found" });
    }
    await deleteK8sLinksForProject(db, input.tenantId, input.name);
    await recordAudit(context, { actor: username, action: "project.delete", tenantId: input.tenantId, target: input.name });
    return { ok: true as const };
  });
