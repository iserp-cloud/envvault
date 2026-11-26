import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { isUniqueViolation } from "../../db/errors.js";
import {
  deleteEnvironmentAcl,
  deleteEnvironmentKey,
  getEnvironmentAcl,
  upsertEnvironmentAcl,
  extendSessions,
  getUser,
  latestSessionExpiry,
  listServiceAccounts,
} from "../../db/store.js";
import {
  countK8sLinksOnEnv,
  deleteK8sLink,
  getK8sLink,
  deleteK8sCluster,
  insertK8sLink,
  listK8sClusters,
  listK8sLinksForCluster,
  listK8sLinksForEnv,
  setK8sLinkAdopt,
  moveK8sLinks,
  reportK8sLink,
  touchK8sCluster,
} from "../../db/k8s.js";
import { DEFAULT_GROUP, validateGroupName } from "@envvault/shared";
import { AuthedContext, aclSatisfies, authed, dbOf, requireActiveMember, requireEnvironmentAccess, requireHuman } from "../base.js";

/**
 * Kubernetes links. The hub keeps only the mapping (environment ↔ namespace/Secret) and what the
 * operator reports back; it never sees a value. The operator decrypts with its cluster token, which
 * the dashboard granted access to the environment (the only place that can wrap the key).
 */

/** Cluster tokens are service tokens whose name starts with this, so they're told apart from CI tokens. */
export const CLUSTER_PREFIX = "svc-k8s-";

const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const SECRET_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

const Location = z.object({
  tenantId: z.string().min(1),
  project: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
});

function linkView(l: Awaited<ReturnType<typeof getK8sLink>> & {}) {
  return {
    id: l.id,
    project: l.project_name,
    environment: l.env_name,
    cluster: l.cluster,
    namespace: l.namespace,
    secretName: l.secret_name,
    direction: l.direction,
    adopt: l.adopt === 1,
    group: l.group_name,
    kind: l.target_kind,
    createdBy: l.created_by,
    createdAt: l.created_at,
    status: l.status,
    message: l.status_message,
    keyCount: l.key_count,
    reportedAt: l.reported_at,
  };
}

/** Only a person who may share the environment can link it (linking hands a key to the cluster token). */
async function requireSharer(context: unknown, tenantId: string, project: string, env: string) {
  const actor = requireHuman((context as AuthedContext).auth);
  await requireEnvironmentAccess(dbOf(context as AuthedContext), tenantId, project, env, actor, "read", "share");
  return actor;
}

async function requireClusterAccount(db: ReturnType<typeof dbOf>, tenantId: string, cluster: string) {
  const user = await getUser(db, cluster);
  if (!user || user.kind !== "service" || user.service_tenant !== tenantId || !cluster.startsWith(CLUSTER_PREFIX)) {
    throw new ORPCError("BAD_REQUEST", { message: "Not a cluster token of this workspace" });
  }
}

/**
 * A cluster token holds one access level per environment, and granting replaces it. So a pull link
 * made after a push link would demote the token to read and break the push. After a link is made the
 * level is raised back to write if any link pushes; after one is removed it is set to what is left
 * (write while any pushes, otherwise read), so a token never keeps more than its links need.
 */
async function fitClusterAccess(db: ReturnType<typeof dbOf>, tenantId: string, project: string, env: string, cluster: string, mayLower: boolean) {
  const acl = await getEnvironmentAcl(db, tenantId, project, env, cluster);
  if (!acl || acl.level === "manage") return;
  const links = (await listK8sLinksForEnv(db, tenantId, project, env)).filter((l) => l.cluster === cluster);
  const level = links.some((l) => l.direction === "push") ? "write" : mayLower ? "read" : acl.level;
  if (acl.level !== level) await upsertEnvironmentAcl(db, { ...acl, level });
}

async function existingPush(db: ReturnType<typeof dbOf>, tenantId: string, project: string, env: string) {
  return (await listK8sLinksForEnv(db, tenantId, project, env)).find((l) => l.direction === "push");
}

function onePushMessage(l: { namespace: string; secret_name: string }): string {
  return `This environment already receives from ${l.namespace}/${l.secret_name}. Only one Secret can push into an environment, because two would overwrite each other's keys. Unlink that one first.`;
}

/** "default" or a valid group name, as the link stores it. */
const GroupField = z
  .string()
  .trim()
  .toLowerCase()
  .default(DEFAULT_GROUP)
  .refine((g) => g === DEFAULT_GROUP || validateGroupName(g) === null, "Not a valid group name (1–40 characters: lower-case letters, digits or -)");

export const k8sLinksCreate = authed
  .input(
    Location.extend({
      cluster: z.string().trim().toLowerCase().min(1).max(64),
      namespace: z.string().trim().regex(NAMESPACE, "Not a valid namespace name"),
      secretName: z.string().trim().regex(SECRET_NAME, "Not a valid Secret name"),
      direction: z.enum(["pull", "push"]),
      /** Which key group the link carries; "default" is every key that has none. */
      group: GroupField,
      /** What a pull writes. A push reads a Secret only. */
      kind: z.enum(["Secret", "ConfigMap"]).default("Secret"),
      /** Take over a Secret that already exists in the cluster instead of refusing it. Pull links only. */
      adopt: z.boolean().default(false),
    }),
  )
  .handler(async ({ input, context }) => {
    const db = dbOf(context);
    const actor = await requireSharer(context, input.tenantId, input.project, input.name);
    await requireClusterAccount(db, input.tenantId, input.cluster);

    if (input.direction === "push" && input.kind !== "Secret") {
      throw new ORPCError("BAD_REQUEST", { message: "Only a Secret can push into an environment" });
    }

    // Two Secrets pushing into one environment overwrite each other's keys whenever a key is in both,
    // taking turns on every check. So an environment takes pushes from one Secret only; pulls are unlimited.
    if (input.direction === "push") {
      const existing = await existingPush(db, input.tenantId, input.project, input.name);
      if (existing) throw new ORPCError("CONFLICT", { message: onePushMessage(existing) });
    }

    // The cluster token must already hold the key (the dashboard grants it first): the hub cannot
    // wrap an environment key itself.
    const acl = await getEnvironmentAcl(db, input.tenantId, input.project, input.name, input.cluster);
    const need = input.direction === "push" ? "write" : "read";
    if (!acl || !aclSatisfies(acl.level, need)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `The cluster token needs ${need} access to this environment first`,
      });
    }

    // The operator says which namespaces it may use; refuse others up front, with a clear reason.
    const known = (await listK8sClusters(db, input.tenantId)).find((c) => c.cluster === input.cluster);
    if (known) {
      const allowed = JSON.parse(known.namespaces) as string[];
      if (allowed.length > 0 && !allowed.includes(input.namespace)) {
        throw new ORPCError("BAD_REQUEST", {
          message: `The operator on this cluster may not use the namespace "${input.namespace}"`,
        });
      }
    }

    try {
      const row = await insertK8sLink(db, {
        tenantId: input.tenantId,
        project: input.project,
        env: input.name,
        cluster: input.cluster,
        namespace: input.namespace,
        secretName: input.secretName,
        direction: input.direction,
        adopt: input.adopt && input.direction === "pull",
        group: input.group,
        kind: input.kind,
        createdBy: actor,
      });
      await fitClusterAccess(db, input.tenantId, input.project, input.name, input.cluster, false);
      await recordAudit(context, {
        actor,
        action: "k8s.link",
        tenantId: input.tenantId,
        target: `${input.project}/${input.name}`,
        detail: `${input.direction} ${input.kind} ${input.namespace}/${input.secretName}${input.group !== DEFAULT_GROUP ? ` group ${input.group}` : ""}${row.adopt ? " (takes over an existing one)" : ""}`,
      });
      return linkView(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Two simultaneous pushes into one environment: the database let only one through.
        const pusher = input.direction === "push" ? await existingPush(db, input.tenantId, input.project, input.name) : undefined;
        if (pusher) throw new ORPCError("CONFLICT", { message: onePushMessage(pusher) });
        throw new ORPCError("CONFLICT", { message: `That ${input.kind} is already linked to an environment` });
      }
      throw err;
    }
  });

/** Lets a pull link take over (or stop taking over) a Secret that already exists in the cluster. */
export const k8sLinksAdopt = authed
  .input(z.object({ tenantId: z.string().min(1), id: z.string().min(1), adopt: z.boolean() }))
  .handler(async ({ input, context }) => {
    const db = dbOf(context);
    const link = await getK8sLink(db, input.tenantId, input.id);
    if (!link) throw new ORPCError("NOT_FOUND", { message: "Link not found" });
    const actor = await requireSharer(context, input.tenantId, link.project_name, link.env_name);
    if (link.direction !== "pull") {
      throw new ORPCError("BAD_REQUEST", { message: "Only a link that writes a Secret or ConfigMap can take one over" });
    }
    await setK8sLinkAdopt(db, input.tenantId, input.id, input.adopt);
    await recordAudit(context, {
      actor,
      action: "k8s.adopt",
      tenantId: input.tenantId,
      target: `${link.project_name}/${link.env_name}`,
      detail: `${input.adopt ? "takes over" : "no longer takes over"} ${link.namespace}/${link.secret_name}`,
    });
    return linkView({ ...link, adopt: input.adopt ? 1 : 0 });
  });

export const k8sLinksList = authed.input(Location).handler(async ({ input, context }) => {
  const db = dbOf(context);
  const actor = requireHuman((context as AuthedContext).auth);
  await requireEnvironmentAccess(db, input.tenantId, input.project, input.name, actor, "read");
  return (await listK8sLinksForEnv(db, input.tenantId, input.project, input.name)).map(linkView);
});

/** Removes the link. The cluster token loses its access to the environment once no link needs it. */
export const k8sLinksDelete = authed
  .input(z.object({ tenantId: z.string().min(1), id: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const db = dbOf(context);
    const link = await getK8sLink(db, input.tenantId, input.id);
    if (!link) throw new ORPCError("NOT_FOUND", { message: "Link not found" });
    const actor = await requireSharer(context, input.tenantId, link.project_name, link.env_name);
    await deleteK8sLink(db, input.tenantId, input.id);
    let revoked = false;
    if ((await countK8sLinksOnEnv(db, input.tenantId, link.project_name, link.env_name, link.cluster)) === 0) {
      await deleteEnvironmentAcl(db, input.tenantId, link.project_name, link.env_name, link.cluster);
      await deleteEnvironmentKey(db, input.tenantId, link.project_name, link.env_name, link.cluster);
      revoked = true;
    } else {
      await fitClusterAccess(db, input.tenantId, link.project_name, link.env_name, link.cluster, true);
    }
    await recordAudit(context, {
      actor,
      action: "k8s.unlink",
      tenantId: input.tenantId,
      target: `${link.project_name}/${link.env_name}`,
      detail: `${link.direction} ${link.namespace}/${link.secret_name}`,
    });
    // The operator already holds the environment key, so rotate the environment to cut it off for good.
    return { ok: true as const, revoked };
  });

export const k8sClustersList = authed
  .input(z.object({ tenantId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const db = dbOf(context);
    await requireActiveMember(db, input.tenantId, requireHuman((context as AuthedContext).auth));
    const seen = new Map((await listK8sClusters(db, input.tenantId)).map((c) => [c.cluster, c]));
    const accounts = (await listServiceAccounts(db, input.tenantId)).filter((a) => a.username.startsWith(CLUSTER_PREFIX));
    return Promise.all(accounts.map(async (a) => {
      const s = seen.get(a.username);
      return {
        cluster: a.username,
        status: a.status,
        // From the hub's own session record: right the moment a token is extended, unlike what the operator last reported.
        expiresAt: await latestSessionExpiry(db, a.username),
        lastSeen: s?.last_seen ?? null,
        version: s?.version ?? "",
        namespaces: s ? (JSON.parse(s.namespaces) as string[]) : [],
        tokenExpiresAt: s?.token_expires_at || null,
      };
    }));
  });

/** Renewing a cluster token is a manager's job, like making one. */
async function requireManager(context: unknown, tenantId: string): Promise<string> {
  const username = requireHuman((context as AuthedContext).auth);
  const m = await requireActiveMember(dbOf(context as AuthedContext), tenantId, username);
  if (m.role !== "owner" && m.role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "Only owners and admins can renew cluster tokens" });
  }
  return username;
}

const ClusterInput = z.object({ tenantId: z.string().min(1), cluster: z.string().trim().toLowerCase().min(1).max(64) });

/** Gives a live cluster token more time. Same token, same key: the operator needs no change. */
export const k8sClustersExtend = authed
  .input(ClusterInput.extend({ expiresInDays: z.number().int().min(1).max(365).default(365) }))
  .handler(async ({ input, context }) => {
    const db = dbOf(context);
    const actor = await requireManager(context, input.tenantId);
    await requireClusterAccount(db, input.tenantId, input.cluster);
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
    if ((await extendSessions(db, input.cluster, expiresAt)) === 0) {
      throw new ORPCError("CONFLICT", { message: "This token has already expired. Replace it with a new one" });
    }
    await recordAudit(context, {
      actor,
      action: "service.extend",
      tenantId: input.tenantId,
      target: input.cluster,
      detail: `expires ${expiresAt.slice(0, 10)}`,
    });
    return { expiresAt };
  });

/** Every link a cluster token carries, so a replacement can be granted the same environments. */
export const k8sClustersLinks = authed.input(ClusterInput).handler(async ({ input, context }) => {
  const db = dbOf(context);
  await requireManager(context, input.tenantId);
  await requireClusterAccount(db, input.tenantId, input.cluster);
  return (await listK8sLinksForCluster(db, input.cluster)).map(linkView);
});

/**
 * Hands the links of one cluster token to a new one (after it was granted the same environments),
 * for when a token expired and its key is gone. The links keep their ids and statuses.
 */
export const k8sClustersReplace = authed
  .input(z.object({ tenantId: z.string().min(1), from: z.string().trim().toLowerCase().min(1).max(64), to: z.string().trim().toLowerCase().min(1).max(64) }))
  .handler(async ({ input, context }) => {
    const db = dbOf(context);
    const actor = await requireManager(context, input.tenantId);
    if (input.from === input.to) throw new ORPCError("BAD_REQUEST", { message: "Pick a different token" });
    await requireClusterAccount(db, input.tenantId, input.from);
    await requireClusterAccount(db, input.tenantId, input.to);
    const links = await listK8sLinksForCluster(db, input.from);
    const missing: string[] = [];
    for (const l of links) {
      const acl = await getEnvironmentAcl(db, input.tenantId, l.project_name, l.env_name, input.to);
      if (!acl || !aclSatisfies(acl.level, l.direction === "push" ? "write" : "read")) missing.push(`${l.project_name}/${l.env_name}`);
    }
    if (missing.length > 0) {
      throw new ORPCError("BAD_REQUEST", { message: `The new token has no access yet to: ${[...new Set(missing)].join(", ")}` });
    }
    let moved: number;
    try {
      moved = await moveK8sLinks(db, input.tenantId, input.from, input.to);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ORPCError("CONFLICT", { message: "The new token already carries a link to one of those Secrets" });
      throw err;
    }
    await deleteK8sCluster(db, input.from);
    await recordAudit(context, {
      actor,
      action: "k8s.replace",
      tenantId: input.tenantId,
      target: input.from,
      detail: `to ${input.to}, ${moved} link(s)`,
    });
    return { moved };
  });

function requireCluster(context: unknown): string {
  const auth = (context as AuthedContext).auth;
  if (auth.kind !== "service" || !auth.username.startsWith(CLUSTER_PREFIX)) {
    throw new ORPCError("FORBIDDEN", { message: "Only a cluster token can do this" });
  }
  return auth.username;
}

/** The operator's poll: says it is alive and which namespaces it may use, and gets its links back. */
export const k8sAgentSync = authed
  .input(
    z.object({
      version: z.string().max(40).default(""),
      namespaces: z.array(z.string().max(63)).max(500).default([]),
      tokenExpiresAt: z.string().max(40).default(""),
    }),
  )
  .handler(async ({ input, context }) => {
    const db = dbOf(context);
    const cluster = requireCluster(context);
    const user = await getUser(db, cluster);
    if (!user?.service_tenant) throw new ORPCError("FORBIDDEN", { message: "Not a workspace token" });
    await touchK8sCluster(db, { cluster, tenantId: user.service_tenant, version: input.version, namespaces: input.namespaces, tokenExpiresAt: input.tokenExpiresAt });
    const links = await listK8sLinksForCluster(db, cluster);
    return links.map((l) => ({
      id: l.id,
      project: l.project_name,
      environment: l.env_name,
      namespace: l.namespace,
      secretName: l.secret_name,
      direction: l.direction,
      adopt: l.adopt === 1,
      group: l.group_name,
      kind: l.target_kind,
    }));
  });

/** What the operator reports per link: a short status and message, and a key count. Never values. */
export const k8sAgentReport = authed
  .input(
    z.object({
      reports: z
        .array(
          z.object({
            id: z.string().min(1).max(64),
            status: z.string().max(40),
            message: z.string().max(300).default(""),
            keyCount: z.number().int().min(0).max(100000).default(0),
          }),
        )
        .max(500),
    }),
  )
  .handler(async ({ input, context }) => {
    const db = dbOf(context);
    const cluster = requireCluster(context);
    for (const r of input.reports) {
      await reportK8sLink(db, cluster, r.id, { status: r.status, message: r.message, keyCount: r.keyCount });
    }
    return { ok: true as const };
  });
