import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database as DbSchema, K8sClusterRow, K8sLinkRow } from "./schema.js";

export type NewLink = {
  tenantId: string;
  project: string;
  env: string;
  cluster: string;
  namespace: string;
  secretName: string;
  direction: "pull" | "push";
  adopt: boolean;
  createdBy: string;
};

export async function insertK8sLink(db: Kysely<DbSchema>, link: NewLink): Promise<K8sLinkRow> {
  const row: K8sLinkRow = {
    id: randomUUID(),
    tenant_id: link.tenantId,
    project_name: link.project,
    env_name: link.env,
    cluster: link.cluster,
    namespace: link.namespace,
    secret_name: link.secretName,
    direction: link.direction,
    created_by: link.createdBy,
    created_at: new Date().toISOString(),
    status: "",
    status_message: "",
    key_count: 0,
    reported_at: "",
    adopt: link.adopt ? 1 : 0,
  };
  await db.insertInto("k8s_links").values(row).execute();
  return row;
}

export async function getK8sLink(db: Kysely<DbSchema>, tenantId: string, id: string): Promise<K8sLinkRow | undefined> {
  return db.selectFrom("k8s_links").selectAll().where("tenant_id", "=", tenantId).where("id", "=", id).executeTakeFirst();
}

export async function listK8sLinksForEnv(
  db: Kysely<DbSchema>,
  tenantId: string,
  project: string,
  env: string,
): Promise<K8sLinkRow[]> {
  return db
    .selectFrom("k8s_links")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", project)
    .where("env_name", "=", env)
    .orderBy("created_at", "asc")
    .execute();
}

export async function listK8sLinksForCluster(db: Kysely<DbSchema>, cluster: string): Promise<K8sLinkRow[]> {
  return db.selectFrom("k8s_links").selectAll().where("cluster", "=", cluster).orderBy("created_at", "asc").execute();
}

export async function countK8sLinksOnEnv(
  db: Kysely<DbSchema>,
  tenantId: string,
  project: string,
  env: string,
  cluster: string,
): Promise<number> {
  const rows = await db
    .selectFrom("k8s_links")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("project_name", "=", project)
    .where("env_name", "=", env)
    .where("cluster", "=", cluster)
    .execute();
  return rows.length;
}

export async function setK8sLinkAdopt(db: Kysely<DbSchema>, tenantId: string, id: string, adopt: boolean): Promise<void> {
  await db.updateTable("k8s_links").set({ adopt: adopt ? 1 : 0 }).where("tenant_id", "=", tenantId).where("id", "=", id).execute();
}

export async function deleteK8sLink(db: Kysely<DbSchema>, tenantId: string, id: string): Promise<void> {
  await db.deleteFrom("k8s_links").where("tenant_id", "=", tenantId).where("id", "=", id).execute();
}

/** What the operator reports for one of its links. Ignored for a link that belongs to another cluster. */
export async function reportK8sLink(
  db: Kysely<DbSchema>,
  cluster: string,
  id: string,
  status: { status: string; message: string; keyCount: number },
): Promise<void> {
  await db
    .updateTable("k8s_links")
    .set({
      status: status.status,
      status_message: status.message,
      key_count: status.keyCount,
      reported_at: new Date().toISOString(),
    })
    .where("cluster", "=", cluster)
    .where("id", "=", id)
    .execute();
}

export async function touchK8sCluster(
  db: Kysely<DbSchema>,
  row: { cluster: string; tenantId: string; version: string; namespaces: string[]; tokenExpiresAt: string },
): Promise<void> {
  const values = {
    cluster: row.cluster,
    tenant_id: row.tenantId,
    last_seen: new Date().toISOString(),
    version: row.version,
    namespaces: JSON.stringify(row.namespaces),
    token_expires_at: row.tokenExpiresAt,
  };
  await db
    .insertInto("k8s_clusters")
    .values(values)
    .onConflict((oc) =>
      oc.column("cluster").doUpdateSet({
        tenant_id: values.tenant_id,
        last_seen: values.last_seen,
        version: values.version,
        namespaces: values.namespaces,
        token_expires_at: values.token_expires_at,
      }),
    )
    .execute();
}

export async function listK8sClusters(db: Kysely<DbSchema>, tenantId: string): Promise<K8sClusterRow[]> {
  return db.selectFrom("k8s_clusters").selectAll().where("tenant_id", "=", tenantId).orderBy("cluster", "asc").execute();
}

/** Hands every link of one cluster token to another (a renewed token), keeping ids and statuses. */
export async function moveK8sLinks(db: Kysely<DbSchema>, tenantId: string, from: string, to: string): Promise<number> {
  const res = await db
    .updateTable("k8s_links")
    .set({ cluster: to })
    .where("tenant_id", "=", tenantId)
    .where("cluster", "=", from)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

export async function deleteK8sCluster(db: Kysely<DbSchema>, cluster: string): Promise<void> {
  await db.deleteFrom("k8s_clusters").where("cluster", "=", cluster).execute();
}

/** Links go with what they point at: a deleted environment or project, or a retired cluster token, must not leave
 * a mapping behind that errors for ever on the operator and keeps its Secret name taken. */
export async function deleteK8sLinksForEnv(db: Kysely<DbSchema>, tenantId: string, project: string, env: string): Promise<void> {
  await db.deleteFrom("k8s_links").where("tenant_id", "=", tenantId).where("project_name", "=", project).where("env_name", "=", env).execute();
}

export async function deleteK8sLinksForProject(db: Kysely<DbSchema>, tenantId: string, project: string): Promise<void> {
  await db.deleteFrom("k8s_links").where("tenant_id", "=", tenantId).where("project_name", "=", project).execute();
}

export async function deleteK8sLinksForCluster(db: Kysely<DbSchema>, tenantId: string, cluster: string): Promise<void> {
  await db.deleteFrom("k8s_links").where("tenant_id", "=", tenantId).where("cluster", "=", cluster).execute();
  await deleteK8sCluster(db, cluster);
}
