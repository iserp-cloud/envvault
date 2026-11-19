import { ORPCError } from "@orpc/server";
import { recordAudit } from "../../audit.js";
import { z } from "zod";
import {
  canManageProject,
  clearRotationPending,
  countEnvironments,
  getStoredEnvironment,
  getStoredProject,
  getTenant,
  getTenantMember,
  getUser,
  hasStoredEnvironment,
  holdKeyVersion,
  insertNewEnvironment,
  deleteEnvironmentVersion,
  getEnvironmentVersion,
  listEnvironmentAcl,
  listEnvironmentVersionPayloads,
  listEnvironmentVersions,
  listEnvironmentsForUser,
  reencryptStoredEnvironmentIf,
  removeStoredEnvironment,
  replaceEnvironmentKeys,
  saveStoredEnvironmentIf,
  getEnvironmentAcl,
  upsertEnvironmentAcl,
  upsertEnvironmentKey,
  upsertStoredProject,
} from "../../db/store.js";
import { isUniqueViolation } from "../../db/errors.js";
import {
  ACL_CAPS,
  MAX_ENVS_PER_PROJECT,
  covers,
  describeAccess,
  effectiveCaps,
  normalizeEnvName,
  normalizeGrant,
} from "@envvault/shared";
import {
  AclCapSchema,
  AclLevelSchema,
  AuthedContext,
  SealedBoxSchema,
  assertValidKeyWraps,
  authed,
  dbOf,
  requireActiveMember,
  requireEnvironmentAccess,
  requireHuman,
  requireUsername,
} from "../base.js";

const KeyWrapsSchema = z
  .array(
    z.object({
      username: z.string().min(1),
      wrappedEnvDek: z.string().min(1).max(4000),
    }),
  )
  .min(1)
  .max(500);

const LocationSchema = z.object({
  tenantId: z.string().min(1),
  project: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
});

function envNameOrThrow(raw: string): string {
  try {
    return normalizeEnvName(raw);
  } catch (err) {
    throw new ORPCError("BAD_REQUEST", {
      message: err instanceof Error ? err.message : "Invalid environment name",
    });
  }
}

/** Stamp the project as recently changed (drives list ordering/"updated" display). */
async function touchProject(
  db: ReturnType<typeof dbOf>,
  tenantId: string,
  project: string,
  updatedAt: string,
) {
  const existing = await getStoredProject(db, project, tenantId);
  if (existing) await upsertStoredProject(db, { ...existing, updatedAt });
}

export const environmentsList = authed
  .input(z.object({ tenantId: z.string().min(1), project: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const username = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    await requireActiveMember(db, input.tenantId, username);
    return listEnvironmentsForUser(db, username, input.tenantId, input.project);
  });

export const environmentsCreate = authed
  .input(
    LocationSchema.omit({ name: true }).extend({
      name: z.string().trim().min(1).max(64),
      payload: SealedBoxSchema,
      keyWraps: KeyWrapsSchema,
    }),
  )
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    await requireActiveMember(db, input.tenantId, username);

    if (!(await canManageProject(db, input.tenantId, input.project, username))) {
      throw new ORPCError("FORBIDDEN", { message: "Requires project manage access" });
    }
    if (!(await getStoredProject(db, input.project, input.tenantId))) {
      throw new ORPCError("NOT_FOUND", { message: "Project not found" });
    }

    const envName = envNameOrThrow(input.name);
    if (await hasStoredEnvironment(db, input.tenantId, input.project, envName)) {
      throw new ORPCError("CONFLICT", { message: "Environment already exists" });
    }
    if ((await countEnvironments(db, input.tenantId, input.project)) >= MAX_ENVS_PER_PROJECT) {
      throw new ORPCError("FORBIDDEN", {
        message: `At most ${MAX_ENVS_PER_PROJECT} environments per project`,
      });
    }

    const tenant = await getTenant(db, input.tenantId);
    if (!tenant) throw new ORPCError("NOT_FOUND", { message: "Tenant not found" });
    const keyWraps = await assertValidKeyWraps(db, input.tenantId, input.keyWraps, {
      owner: tenant.owner_username,
      creator: username,
    });

    const updatedAt = new Date().toISOString();
    // One transaction with a duplicate-refusing insert, so a concurrent request for the same name
    // can't mix its ciphertext with these keys, and a failure halfway leaves nothing behind.
    try {
      await db.transaction().execute(async (trx) => {
        await insertNewEnvironment(trx, {
          tenantId: input.tenantId,
          projectName: input.project,
          name: envName,
          updatedAt,
          payload: input.payload,
          updatedBy: username,
        });
        for (const wrap of keyWraps) {
          await upsertEnvironmentKey(trx, {
            tenant_id: input.tenantId,
            project_name: input.project,
            env_name: envName,
            username: wrap.username,
            wrapped_env_dek: wrap.wrappedEnvDek,
          });
          await upsertEnvironmentAcl(trx, {
            tenant_id: input.tenantId,
            project_name: input.project,
            env_name: envName,
            username: wrap.username,
            level: "manage",
            caps: "",
          });
        }
        await touchProject(trx, input.tenantId, input.project, updatedAt);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ORPCError("CONFLICT", { message: "Environment already exists" });
      throw err;
    }
    await recordAudit(context, { actor: username, action: "env.create", tenantId: input.tenantId, target: `${input.project}/${envName}` });
    return { name: envName, updatedAt };
  });

export const environmentsDelete = authed
  .input(LocationSchema)
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    const envName = envNameOrThrow(input.name);
    await requireEnvironmentAccess(db, input.tenantId, input.project, envName, username, "read", "delete");

    const removed = await removeStoredEnvironment(db, input.tenantId, input.project, envName);
    if (removed === "last") {
      throw new ORPCError("BAD_REQUEST", {
        message: "Cannot delete the last environment in a project",
      });
    }
    await recordAudit(context, { actor: username, action: "env.delete", tenantId: input.tenantId, target: `${input.project}/${envName}` });
    return { ok: true as const };
  });

/** Returns ciphertext only; the client decrypts with the DEK it unwrapped locally. */
export const environmentsGetEnv = authed
  .input(LocationSchema)
  .handler(async ({ input, context }) => {
    const username = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    const envName = envNameOrThrow(input.name);
    await requireEnvironmentAccess(db, input.tenantId, input.project, envName, username, "read");

    const stored = await getStoredEnvironment(db, input.tenantId, input.project, envName);
    if (!stored) throw new ORPCError("NOT_FOUND", { message: "Environment not found" });
    await recordAudit(context, { actor: username, action: "env.read", tenantId: input.tenantId, target: `${input.project}/${envName}` });
    return {
      tenantId: stored.tenantId,
      projectName: stored.projectName,
      name: stored.name,
      updatedAt: stored.updatedAt,
      payload: stored.payload,
    };
  });

export const environmentsSaveEnv = authed
  .input(
    LocationSchema.extend({
      payload: SealedBoxSchema,
      /** updatedAt the client last saw; rejects the write if someone else saved since. */
      baseUpdatedAt: z.string().optional(),
      /** Short label for this version, e.g. "Restored from v3". */
      note: z.string().trim().max(120).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const username = requireUsername((context as AuthedContext).auth);
    const db = dbOf(context);
    const envName = envNameOrThrow(input.name);
    await requireEnvironmentAccess(db, input.tenantId, input.project, envName, username, "write");

    const existing = await getStoredEnvironment(db, input.tenantId, input.project, envName);
    if (!existing) throw new ORPCError("NOT_FOUND", { message: "Environment not found" });
    if (input.baseUpdatedAt && input.baseUpdatedAt !== existing.updatedAt) {
      throw new ORPCError("CONFLICT", {
        message: "This environment was changed by someone else. Reload and re-apply your edits.",
      });
    }

    const updatedAt = new Date().toISOString();
    // Conditional on what we just read, so a save that landed in between is a conflict, not a silent overwrite.
    const saved = await saveStoredEnvironmentIf(
      db,
      { ...existing, updatedAt, payload: input.payload },
      existing.updatedAt,
      { by: username, note: input.note },
    );
    if (!saved) {
      throw new ORPCError("CONFLICT", {
        message: "This environment was changed by someone else. Reload and re-apply your edits.",
      });
    }
    await touchProject(db, input.tenantId, input.project, updatedAt);
    await recordAudit(context, { actor: username, action: "env.save", tenantId: input.tenantId, target: `${input.project}/${envName}` });
    return { name: envName, updatedAt };
  });

export const environmentsGrantAccess = authed
  .input(
    LocationSchema.extend({
      username: z.string().trim().min(1),
      level: AclLevelSchema,
      /** Extra powers on top of read/write. Ignored for `manage`, which has them all. */
      caps: z.array(AclCapSchema).max(ACL_CAPS.length).default([]),
      wrappedEnvDek: z.string().min(1).max(4000),
      /** The key generation `wrappedEnvDek` was made from (from `environments.list`); stale ones are refused. */
      keyVersion: z.number().int().min(1),
    }),
  )
  .handler(async ({ input, context }) => {
    const actor = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    const envName = envNameOrThrow(input.name);
    const { acl: actorAcl } = await requireEnvironmentAccess(
      db, input.tenantId, input.project, envName, actor, "read", "share",
    );
    const grant = normalizeGrant(input.level, input.caps);
    // You can hand out only what you hold, so sharing never raises anyone above yourself.
    if (!covers(actorAcl, { level: grant.level, caps: grant.caps })) {
      throw new ORPCError("FORBIDDEN", {
        message: "You can't grant more access than you have on this environment",
      });
    }

    const target = input.username.trim().toLowerCase();
    const tenant = await getTenant(db, input.tenantId);
    if (tenant && target === tenant.owner_username) {
      // Granting replaces the target's key and level; a manager must not be able to
      // swap out (and so lock out) the owner's access.
      throw new ORPCError("BAD_REQUEST", { message: "The owner's access can't be changed" });
    }
    const member = await getTenantMember(db, input.tenantId, target);
    if (!member || (member.status !== "active" && member.status !== "pending")) {
      throw new ORPCError("BAD_REQUEST", {
        message: "User must be invited to or a member of this organization",
      });
    }
    const user = await getUser(db, target);
    if (!user || !user.public_key) {
      throw new ORPCError("NOT_FOUND", { message: "User not found" });
    }
    // Re-granting replaces the target's access, so it can't be used to demote (or otherwise
    // rewrite) someone who holds more than you do.
    const existingAcl = await getEnvironmentAcl(db, input.tenantId, input.project, envName, target);
    if (existingAcl && !covers(actorAcl, existingAcl)) {
      throw new ORPCError("FORBIDDEN", {
        message: `${target} has access you don't have, so you can't change it`,
      });
    }

    // Check the key generation and write the grant in one transaction: if the environment was rotated
    // after the client loaded its key, the wrapped key would not open the current secrets.
    await db.transaction().execute(async (trx) => {
      if (!(await holdKeyVersion(trx, input.tenantId, input.project, envName, input.keyVersion))) {
        throw new ORPCError("CONFLICT", {
          message: "This environment's key was rotated. Reload it and share again.",
        });
      }
      await upsertEnvironmentKey(trx, {
        tenant_id: input.tenantId,
        project_name: input.project,
        env_name: envName,
        username: target,
        wrapped_env_dek: input.wrappedEnvDek,
      });
      await upsertEnvironmentAcl(trx, {
        tenant_id: input.tenantId,
        project_name: input.project,
        env_name: envName,
        username: target,
        level: grant.level,
        caps: grant.caps.join(","),
      });
    });
    await recordAudit(context, { actor, action: "env.grant", tenantId: input.tenantId, target: `${input.project}/${envName}`, detail: `${target}: ${describeAccess(grant.level, grant.caps)}` });
    return { ok: true as const };
  });

/**
 * Rotate the environment key. The client re-encrypts the payload under a fresh
 * DEK and wraps it only for the users who should keep access. Anyone left out
 * loses their key and ACL row, and — because the DEK changed — cannot decrypt
 * future (or re-encrypted) data even if they kept a copy of the old one.
 */
export const environmentsRotate = authed
  .input(
    LocationSchema.extend({
      payload: SealedBoxSchema,
      keyWraps: KeyWrapsSchema,
      baseUpdatedAt: z.string().optional(),
      /** Every kept version, re-encrypted under the new key. Versions left out are dropped. */
      history: z
        .array(z.object({ id: z.string().min(1).max(64), payload: SealedBoxSchema }))
        .max(100)
        .default([]),
    }),
  )
  .handler(async ({ input, context }) => {
    const actor = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    const envName = envNameOrThrow(input.name);
    const { acl: actorAcl } = await requireEnvironmentAccess(
      db, input.tenantId, input.project, envName, actor, "read", "rotate",
    );

    const existing = await getStoredEnvironment(db, input.tenantId, input.project, envName);
    if (!existing) throw new ORPCError("NOT_FOUND", { message: "Environment not found" });
    if (input.baseUpdatedAt && input.baseUpdatedAt !== existing.updatedAt) {
      throw new ORPCError("CONFLICT", {
        message: "This environment was changed by someone else. Reload and try again.",
      });
    }

    const tenant = await getTenant(db, input.tenantId);
    if (!tenant) throw new ORPCError("NOT_FOUND", { message: "Tenant not found" });

    const acl = await listEnvironmentAcl(db, input.tenantId, input.project, envName);
    const allowed = new Set(acl.map((a) => a.username));
    const wraps = input.keyWraps.map((w) => ({
      username: w.username.trim().toLowerCase(),
      wrappedEnvDek: w.wrappedEnvDek,
    }));
    const users = new Set(wraps.map((w) => w.username));

    if (!users.has(actor)) {
      throw new ORPCError("BAD_REQUEST", { message: "keyWraps must include you" });
    }
    if (allowed.has(tenant.owner_username) && !users.has(tenant.owner_username)) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Cannot revoke the tenant owner's access",
      });
    }
    for (const name of users) {
      if (!allowed.has(name)) {
        throw new ORPCError("BAD_REQUEST", {
          message: `"${name}" has no access to this environment; grant it first`,
        });
      }
    }

    // Leaving someone out of the new key revokes them, which needs at least their access.
    for (const row of acl) {
      if (!users.has(row.username) && !covers(actorAcl, row)) {
        throw new ORPCError("FORBIDDEN", {
          message: `${row.username} has access you don't have, so you can't revoke it`,
        });
      }
    }

    const updatedAt = new Date().toISOString();
    // Payload, keys and the rotation flag change together, and only if nobody saved meanwhile.
    await db.transaction().execute(async (trx) => {
      let ok: boolean;
      try {
        ok = await reencryptStoredEnvironmentIf(
          trx,
          { ...existing, updatedAt, payload: input.payload },
          existing.updatedAt,
          input.history,
        );
      } catch {
        throw new ORPCError("BAD_REQUEST", { message: "History names a version that isn't part of this environment" });
      }
      if (!ok) {
        throw new ORPCError("CONFLICT", {
          message: "This environment was changed by someone else. Reload and try again.",
        });
      }
      await replaceEnvironmentKeys(trx, input.tenantId, input.project, envName, wraps);
      await clearRotationPending(trx, input.tenantId, input.project, envName);
    });
    await touchProject(db, input.tenantId, input.project, updatedAt);
    const removed = [...allowed].filter((u) => !users.has(u));
    await recordAudit(context, { actor, action: "env.rotate", tenantId: input.tenantId, target: `${input.project}/${envName}`, detail: removed.length ? `revoked: ${removed.join(", ")}` : "" });
    return { ok: true as const, updatedAt };
  });

export const environmentsListAccess = authed
  .input(LocationSchema)
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    const envName = envNameOrThrow(input.name);
    // Sharing and rotating both need to see who currently has access.
    await requireEnvironmentAccess(db, input.tenantId, input.project, envName, username, "read", ["share", "rotate"]);
    const rows = await listEnvironmentAcl(db, input.tenantId, input.project, envName);
    return rows.map((r) => ({ username: r.username, level: r.level, caps: effectiveCaps(r.level, r.caps) }));
  });

// ── version history ─────────────────────────────────────────────────────────
// Previous payloads stay ciphertext under the environment's current key, so reading one is
// as sensitive as reading the environment itself. Humans only: CI tokens read the current value.

/** The current version's metadata plus the (newest-first) list of earlier ones. */
export const environmentsVersionsList = authed
  .input(LocationSchema)
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    const envName = envNameOrThrow(input.name);
    await requireEnvironmentAccess(db, input.tenantId, input.project, envName, username, "read");
    const [current, history] = await Promise.all([
      getStoredEnvironment(db, input.tenantId, input.project, envName),
      listEnvironmentVersions(db, input.tenantId, input.project, envName),
    ]);
    if (!current) throw new ORPCError("NOT_FOUND", { message: "Environment not found" });
    return {
      current: {
        version: current.version,
        updatedAt: current.updatedAt,
        updatedBy: current.updatedBy,
        note: current.note,
      },
      history,
    };
  });

export const environmentsVersionsGet = authed
  .input(LocationSchema.extend({ id: z.string().min(1).max(64) }))
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    const envName = envNameOrThrow(input.name);
    await requireEnvironmentAccess(db, input.tenantId, input.project, envName, username, "read");
    const version = await getEnvironmentVersion(db, input.tenantId, input.project, envName, input.id);
    if (!version) throw new ORPCError("NOT_FOUND", { message: "Version not found" });
    await recordAudit(context, {
      actor: username,
      action: "env.read",
      tenantId: input.tenantId,
      target: `${input.project}/${envName}`,
      detail: `v${version.version}`,
    });
    return version;
  });

export const environmentsVersionsDelete = authed
  .input(LocationSchema.extend({ id: z.string().min(1).max(64) }))
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    const envName = envNameOrThrow(input.name);
    await requireEnvironmentAccess(db, input.tenantId, input.project, envName, username, "read", "delete");
    const gone = await deleteEnvironmentVersion(db, input.tenantId, input.project, envName, input.id);
    if (!gone) throw new ORPCError("NOT_FOUND", { message: "Version not found" });
    await recordAudit(context, {
      actor: username,
      action: "env.version_delete",
      tenantId: input.tenantId,
      target: `${input.project}/${envName}`,
    });
    return { ok: true as const };
  });

/** Every version's ciphertext, so the client can re-encrypt it under a new key when rotating. */
export const environmentsVersionsExport = authed
  .input(LocationSchema)
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    const db = dbOf(context);
    const envName = envNameOrThrow(input.name);
    await requireEnvironmentAccess(db, input.tenantId, input.project, envName, username, "read", "rotate");
    return listEnvironmentVersionPayloads(db, input.tenantId, input.project, envName);
  });
