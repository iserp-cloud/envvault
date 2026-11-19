import { type Kysely } from "kysely";
import type { Database as DbSchema, ProjectRow } from "./schema.js";
import { hasCap } from "@envvault/shared";

export type StoredProject = {
  tenantId: string;
  name: string;
  updatedAt: string;
};

function rowToStored(row: ProjectRow): StoredProject {
  return { tenantId: row.tenant_id, name: row.name, updatedAt: row.updated_at };
}

export async function listStoredProjects(
  db: Kysely<DbSchema>,
  tenantId?: string,
): Promise<StoredProject[]> {
  let query = db.selectFrom("projects").selectAll().orderBy("name", "asc");
  if (tenantId != null) query = query.where("tenant_id", "=", tenantId);
  return (await query.execute()).map(rowToStored);
}

export async function getStoredProject(
  db: Kysely<DbSchema>,
  name: string,
  tenantId: string,
): Promise<StoredProject | null> {
  const row = await db
    .selectFrom("projects")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("name", "=", name)
    .executeTakeFirst();
  return row ? rowToStored(row) : null;
}

/** Insert a project that must not exist yet: a duplicate is a unique-key error, never an overwrite. */
export async function insertNewProject(db: Kysely<DbSchema>, stored: StoredProject): Promise<void> {
  await db
    .insertInto("projects")
    .values({ tenant_id: stored.tenantId, name: stored.name, updated_at: stored.updatedAt })
    .execute();
}

export async function upsertStoredProject(
  db: Kysely<DbSchema>,
  stored: StoredProject,
): Promise<void> {
  await db
    .insertInto("projects")
    .values({
      tenant_id: stored.tenantId,
      name: stored.name,
      updated_at: stored.updatedAt,
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "name"]).doUpdateSet({ updated_at: stored.updatedAt }),
    )
    .execute();
}

export async function hasStoredProject(
  db: Kysely<DbSchema>,
  name: string,
  tenantId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("projects")
    .select("name")
    .where("tenant_id", "=", tenantId)
    .where("name", "=", name)
    .executeTakeFirst();
  return Boolean(row);
}

export async function removeStoredProject(
  db: Kysely<DbSchema>,
  name: string,
  tenantId: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("environment_keys")
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", name)
      .execute();
    await trx
      .deleteFrom("environment_acl")
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", name)
      .execute();
    await trx
      .deleteFrom("environment_versions")
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", name)
      .execute();
    await trx
      .deleteFrom("environments")
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", name)
      .execute();
    const result = await trx
      .deleteFrom("projects")
      .where("tenant_id", "=", tenantId)
      .where("name", "=", name)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  });
}

export async function listActiveAdminsAndOwner(
  db: Kysely<DbSchema>,
  tenantId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom("tenant_members")
    .select("username")
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "active")
    .where("role", "in", ["owner", "admin"])
    .execute();
  return rows.map((r) => r.username);
}

/**
 * Projects a user can read (via environment keys + ACL), with the highest level
 * across environments and the most recent update.
 */
export async function listProjectsForUser(
  db: Kysely<DbSchema>,
  username: string,
  tenantId?: string,
): Promise<
  Array<{
    tenantId: string;
    name: string;
    updatedAt: string;
    level: "read" | "write" | "manage";
  }>
> {
  let query = db
    .selectFrom("environment_keys")
    .innerJoin("environments", (join) =>
      join
        .onRef("environments.tenant_id", "=", "environment_keys.tenant_id")
        .onRef("environments.project_name", "=", "environment_keys.project_name")
        .onRef("environments.name", "=", "environment_keys.env_name"),
    )
    .innerJoin("environment_acl", (join) =>
      join
        .onRef("environment_acl.tenant_id", "=", "environment_keys.tenant_id")
        .onRef("environment_acl.project_name", "=", "environment_keys.project_name")
        .onRef("environment_acl.env_name", "=", "environment_keys.env_name")
        .onRef("environment_acl.username", "=", "environment_keys.username"),
    )
    .select([
      "environment_keys.tenant_id",
      "environment_keys.project_name",
      "environments.updated_at",
      "environment_acl.level",
    ])
    .where("environment_keys.username", "=", username)
    .orderBy("environment_keys.project_name", "asc");
  if (tenantId) query = query.where("environment_keys.tenant_id", "=", tenantId);

  const rows = await query.execute();
  const byProject = new Map<
    string,
    { tenantId: string; name: string; updatedAt: string; level: "read" | "write" | "manage" }
  >();
  const order = { read: 1, write: 2, manage: 3 } as const;
  for (const r of rows) {
    const key = `${r.tenant_id}\0${r.project_name}`;
    const level = r.level as "read" | "write" | "manage";
    const existing = byProject.get(key);
    if (!existing || order[level] > order[existing.level]) {
      byProject.set(key, {
        tenantId: r.tenant_id,
        name: r.project_name,
        updatedAt: existing && existing.updatedAt > r.updated_at ? existing.updatedAt : r.updated_at,
        level,
      });
    } else if (r.updated_at > existing.updatedAt) {
      existing.updatedAt = r.updated_at;
    }
  }
  return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Tenant owners and anyone with manage access on any environment of the project. */
export async function canManageProject(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  username: string,
): Promise<boolean> {
  const [tenant, acl] = await Promise.all([
    db.selectFrom("tenants").select("owner_username").where("id", "=", tenantId).executeTakeFirst(),
    db
      .selectFrom("environment_acl")
      .select("level")
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", projectName)
      .where("username", "=", username)
      .where("level", "=", "manage")
      .executeTakeFirst(),
  ]);
  if (tenant?.owner_username === username) return true;
  return Boolean(acl);
}

/**
 * Deleting a project removes every environment in it, so the delete permission on a single environment
 * isn't enough: the caller must own or administer the workspace, or hold the delete permission on all of them.
 */
export async function canDeleteProject(
  db: Kysely<DbSchema>,
  tenantId: string,
  projectName: string,
  username: string,
): Promise<boolean> {
  const [tenant, member] = await Promise.all([
    db.selectFrom("tenants").select("owner_username").where("id", "=", tenantId).executeTakeFirst(),
    db
      .selectFrom("tenant_members")
      .select(["role", "status"])
      .where("tenant_id", "=", tenantId)
      .where("username", "=", username)
      .executeTakeFirst(),
  ]);
  if (tenant?.owner_username === username) return true;
  if (member?.status === "active" && member.role === "admin") return true;

  const [envs, grants] = await Promise.all([
    db
      .selectFrom("environments")
      .select("name")
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", projectName)
      .execute(),
    db
      .selectFrom("environment_acl")
      .select(["env_name", "level", "caps"])
      .where("tenant_id", "=", tenantId)
      .where("project_name", "=", projectName)
      .where("username", "=", username)
      .execute(),
  ]);
  const managed = grants.filter((g) => hasCap(g.level, g.caps, "delete"));
  const have = new Set(managed.map((r) => r.env_name));
  return envs.length > 0 && envs.every((e) => have.has(e.name));
}
