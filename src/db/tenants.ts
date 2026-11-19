import { type Kysely } from "kysely";
import type {
  Database as DbSchema,
  TenantMemberRow,
  TenantRow,
} from "./schema.js";
import { getUser } from "./users.js";

export async function createTenant(db: Kysely<DbSchema>, tenant: TenantRow): Promise<void> {
  await db.insertInto("tenants").values(tenant).execute();
}

export async function getTenant(
  db: Kysely<DbSchema>,
  id: string,
): Promise<TenantRow | undefined> {
  return db.selectFrom("tenants").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function getTenantBySlug(
  db: Kysely<DbSchema>,
  slug: string,
): Promise<TenantRow | undefined> {
  return db
    .selectFrom("tenants")
    .selectAll()
    .where("slug", "=", slug.trim().toLowerCase())
    .executeTakeFirst();
}

/** True if slug is taken by a tenant or a user account (shared namespace). */
export async function isHandleTaken(
  db: Kysely<DbSchema>,
  handle: string,
  opts?: { ignoreTenantId?: string },
): Promise<boolean> {
  const slug = handle.trim().toLowerCase();
  const user = await getUser(db, slug);
  if (user) return true;
  const tenant = await getTenantBySlug(db, slug);
  if (!tenant) return false;
  if (opts?.ignoreTenantId && tenant.id === opts.ignoreTenantId) return false;
  return true;
}

export async function countOwnedOrgs(
  db: Kysely<DbSchema>,
  username: string,
): Promise<number> {
  const row = await db
    .selectFrom("tenants")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("owner_username", "=", username)
    .where("kind", "=", "org")
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function listTenantsForUser(
  db: Kysely<DbSchema>,
  username: string,
): Promise<Array<TenantRow & { role: TenantMemberRow["role"]; status: TenantMemberRow["status"] }>> {
  const rows = await db
    .selectFrom("tenant_members")
    .innerJoin("tenants", "tenants.id", "tenant_members.tenant_id")
    .select([
      "tenants.id",
      "tenants.slug",
      "tenants.name",
      "tenants.owner_username",
      "tenants.kind",
      "tenants.created_at",
      "tenant_members.role",
      "tenant_members.status",
    ])
    .where("tenant_members.username", "=", username)
    .where("tenant_members.status", "=", "active")
    .orderBy("tenants.name", "asc")
    .execute();

  const mapped = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    owner_username: r.owner_username,
    kind: (r.kind === "personal" ? "personal" : "org") as TenantRow["kind"],
    created_at: r.created_at,
    role: r.role as TenantMemberRow["role"],
    status: r.status as TenantMemberRow["status"],
  }));

  // Personal vault first, then orgs A–Z
  mapped.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "personal" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return mapped;
}

export async function listPendingInvites(
  db: Kysely<DbSchema>,
  username: string,
): Promise<Array<TenantRow & { role: TenantMemberRow["role"] }>> {
  const rows = await db
    .selectFrom("tenant_members")
    .innerJoin("tenants", "tenants.id", "tenant_members.tenant_id")
    .select([
      "tenants.id",
      "tenants.slug",
      "tenants.name",
      "tenants.owner_username",
      "tenants.created_at",
      "tenant_members.role",
    ])
    .where("tenant_members.username", "=", username)
    .where("tenant_members.status", "=", "pending")
    .orderBy("tenants.name", "asc")
    .execute();
  const mapped = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    owner_username: r.owner_username,
    kind: "org" as const, // invites are org-only
    created_at: r.created_at,
    role: r.role as TenantMemberRow["role"],
  }));
  return mapped;
}

export async function upsertTenantMember(
  db: Kysely<DbSchema>,
  member: TenantMemberRow,
): Promise<void> {
  await db
    .insertInto("tenant_members")
    .values(member)
    .onConflict((oc) =>
      oc.columns(["tenant_id", "username"]).doUpdateSet({
        role: member.role,
        status: member.status,
      }),
    )
    .execute();
}

export async function getTenantMember(
  db: Kysely<DbSchema>,
  tenantId: string,
  username: string,
): Promise<TenantMemberRow | undefined> {
  return db
    .selectFrom("tenant_members")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("username", "=", username)
    .executeTakeFirst();
}

export async function listTenantMembers(
  db: Kysely<DbSchema>,
  tenantId: string,
): Promise<TenantMemberRow[]> {
  return db
    .selectFrom("tenant_members")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("username", "asc")
    .execute();
}

export async function removeTenantMember(
  db: Kysely<DbSchema>,
  tenantId: string,
  username: string,
): Promise<void> {
  // One unit: a partial removal would leave wrapped keys behind for someone who is out.
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("tenant_members")
      .where("tenant_id", "=", tenantId)
      .where("username", "=", username)
      .execute();
    await trx
      .deleteFrom("environment_keys")
      .where("tenant_id", "=", tenantId)
      .where("username", "=", username)
      .execute();
    await trx
      .deleteFrom("environment_acl")
      .where("tenant_id", "=", tenantId)
      .where("username", "=", username)
      .execute();
  });
}

/**
 * Delete an organization and everything in it, atomically. Service accounts that belonged
 * to it are disabled and signed out (their tokens would otherwise keep working).
 */
export async function deleteTenant(
  db: Kysely<DbSchema>,
  tenantId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const service = await trx
      .selectFrom("users")
      .select("username")
      .where("kind", "=", "service")
      .where("service_tenant", "=", tenantId)
      .execute();
    const names = service.map((u) => u.username);
    if (names.length > 0) {
      await trx.updateTable("users").set({ status: "disabled" }).where("username", "in", names).execute();
      await trx.deleteFrom("sessions").where("username", "in", names).execute();
    }
    await trx.deleteFrom("environment_keys").where("tenant_id", "=", tenantId).execute();
    await trx.deleteFrom("environment_acl").where("tenant_id", "=", tenantId).execute();
    await trx.deleteFrom("environment_versions").where("tenant_id", "=", tenantId).execute();
    await trx.deleteFrom("environments").where("tenant_id", "=", tenantId).execute();
    await trx.deleteFrom("projects").where("tenant_id", "=", tenantId).execute();
    await trx.deleteFrom("tenant_members").where("tenant_id", "=", tenantId).execute();
    await trx.deleteFrom("tenants").where("id", "=", tenantId).execute();
  });
}
