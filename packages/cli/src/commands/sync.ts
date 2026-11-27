import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  cleanLabels,
  hasGroupMarkers,
  levelAtLeast,
  mergeEnv,
  noGroups,
  parseEnv,
  parseEnvGroups,
  serializeEnv,
  serializeEnvGroups,
  type EnvMap,
} from "@envvault/shared";
import { loadConfig, requireSession, type EnvVaultConfig } from "../config.js";
import { ensureEnvironment, hubEnvironmentAccess, hubGetEnv, hubSaveEnv, isDenied, type AccessLevel } from "../remote.js";
import { resolveTenantArg, writeSecretFile } from "../cli/helpers.js";
import { loadTreeTargets } from "../context.js";
import { selectMany } from "../cli/select.js";
import { filterTargets, type TreeTarget } from "../tree.js";
import { c, hint, info, messageOf, plural, rel, success, warn } from "../ui.js";

/**
 * Pull one target's environment into its file. When the environment has key groups the file gets a
 * `# @group name` line above each group's keys (`groups: true` always, `groups: false` never); with none it is
 * plain KEY=value, as always.
 */
export async function pullTarget(
  config: EnvVaultConfig,
  t: { project: string; env: string; file: string; merge: boolean; tenantId?: string; groups?: boolean },
): Promise<{ keys: number }> {
  const loaded = await hubGetEnv(config, t.project, t.env, t.tenantId);
  let env: EnvMap = loaded.env;
  let groups: Record<string, string> = loaded.groups;
  const old = t.merge && existsSync(t.file) ? readFileSync(t.file, "utf8") : null;
  const withGroups = t.groups ?? (Object.keys(loaded.groups).length > 0 || (old !== null && hasGroupMarkers(old)));
  if (old !== null) {
    const text = old;
    if (withGroups) {
      const prev = parseEnvGroups(text);
      env = mergeEnv(prev.vars, loaded.env);
      groups = { ...prev.groups, ...loaded.groups };
      for (const key of Object.keys(loaded.env)) if (!loaded.groups[key]) delete groups[key];
    } else {
      env = mergeEnv(parseEnv(text), loaded.env);
    }
  }
  mkdirSync(dirname(t.file), { recursive: true });
  writeSecretFile(t.file, withGroups ? serializeEnvGroups(env, groups) : serializeEnv(env));
  return { keys: Object.keys(env).length };
}

/**
 * Whether the environment is there for you to push to. The hub does not say whether a name is absent or hidden from
 * you, so false means "not found or no access". Unknown (offline, a failed lookup) counts as there, so the push
 * itself reports the real problem.
 */
export async function targetExists(
  config: EnvVaultConfig,
  t: { project: string; env: string; tenantId?: string },
): Promise<boolean> {
  try {
    const name = t.env.trim().toLowerCase() || "default";
    return (await hubEnvironmentAccess(config, t.project, t.tenantId)).some((e) => e.name === name);
  } catch {
    return true;
  }
}

/** What creating a missing target added on the hub, in words ("project and environment", …), or "". */
export function describeCreated(c: { createdProject: boolean; createdEnv: boolean }): string {
  return c.createdProject ? "project and environment" : c.createdEnv ? "environment" : "";
}

/**
 * The groups and registry to keep when a file replaces an environment's values. A target that is missing or
 * unreadable has none to keep; any other failure (network, decryption) stops the push, because saving
 * without them would wipe them all.
 */
async function currentGrouping(config: EnvVaultConfig, t: { project: string; env: string; tenantId?: string }) {
  try {
    const cur = await hubGetEnv(config, t.project, t.env, t.tenantId);
    return { groups: cur.groups, labels: cur.labels };
  } catch (err) {
    // not there or not readable: the save that follows fails the same way, or creates it with nothing to keep
    if (isDenied(err)) return noGroups();
    throw err;
  }
}

/**
 * Push a file to one target's environment; with `create`, a missing project / environment is created first.
 * A file with `# @group name` lines has them decide each key's group, and the names join the environment's
 * registry (`groups: false` ignores them and `markersIgnored` says so). A file with none has no say about groups:
 * keys that stay keep the group they were given in the dashboard. `groups: true` reads the file as the whole truth
 * even with no markers, which puts every key in the default group.
 */
export async function pushTarget(
  config: EnvVaultConfig,
  t: { project: string; env: string; file: string; tenantId?: string; create?: boolean; groups?: boolean },
): Promise<{ keys: number; updatedAt: string; created: string; markersIgnored: boolean }> {
  if (!existsSync(t.file)) throw new Error(`File not found: ${rel(t.file)}`);
  const text = readFileSync(t.file, "utf8");
  const withGroups = t.groups ?? hasGroupMarkers(text);
  const parsed = withGroups ? parseEnvGroups(text) : { vars: parseEnv(text), groups: undefined };
  const env = parsed.vars;
  const created = t.create ? describeCreated(await ensureEnvironment(config, t.project, t.env, t.tenantId)) : "";
  // Anyone who can write an environment can read it, so this does not need more access than the push itself.
  const current = await currentGrouping(config, t);
  const grouping = parsed.groups
    ? { groups: parsed.groups, labels: cleanLabels([...current.labels, ...Object.values(parsed.groups)]) }
    : current;
  const saved = await hubSaveEnv(config, t.project, t.env, env, grouping, t.tenantId);
  return {
    keys: Object.keys(env).length,
    updatedAt: saved.updatedAt,
    created,
    markersIgnored: t.groups === false && hasGroupMarkers(text),
  };
}

const MARKERS_IGNORED = "The file has # @group lines that were left out because of --no-groups.";

export type TreeSyncOptions = {
  config?: string;
  tenant?: string;
  /** `--workspace`: another name for `tenant`. */
  workspace?: string;
  dryRun?: boolean;
  /** Report targets you may not open/write as skipped instead of failing the run. */
  skipDenied?: boolean;
  /** Pick which targets to sync from a list, instead of naming them. */
  interactive?: boolean;
  /** Push: create missing projects / environments for every target (a target's own `create` setting also counts). */
  create?: boolean;
  /** `--groups` / `--no-groups`: always / never read and write `# @group` lines; unset follows the file (push) or the environment (pull). */
  groups?: boolean;
};

/** What you may do with a target: undefined when unknown (offline or not logged in), null for nothing. */
export type TargetAccess = { level: AccessLevel; caps: string } | null | undefined;

/**
 * Look up your access to each target: one hub call per workspace/project, no keys opened.
 * Targets whose lookup fails (offline, not logged in) come back as unknown.
 */
export async function loadTargetAccess(
  config: EnvVaultConfig,
  targets: TreeTarget[],
  tenantOverride?: string,
): Promise<Map<TreeTarget, TargetAccess>> {
  const result = new Map<TreeTarget, TargetAccess>();
  const tenants = new Map<string | undefined, Promise<string>>();
  const projects = new Map<string, Promise<Awaited<ReturnType<typeof hubEnvironmentAccess>> | undefined>>();
  await Promise.all(
    targets.map(async (t) => {
      try {
        const arg = tenantOverride ?? t.tenant;
        if (!tenants.has(arg)) tenants.set(arg, resolveTenantArg(config, arg));
        const tenantId = await tenants.get(arg)!;
        const key = `${tenantId}\0${t.project}`;
        if (!projects.has(key)) {
          projects.set(key, hubEnvironmentAccess(config, t.project, tenantId).catch(() => undefined));
        }
        const rows = await projects.get(key)!;
        result.set(t, rows ? (rows.find((r) => r.name === t.env) ?? null) : undefined);
      } catch {
        result.set(t, undefined);
      }
    }),
  );
  return result;
}

/**
 * "not found or no access", "read-only" for a push, or null when the action would be allowed.
 * The hub never says whether something is missing or hidden from you, so one answer covers both;
 * a push that creates missing things isn't blocked by a target that isn't there yet.
 */
function blockedBy(access: TargetAccess, direction: "pull" | "push", creates = false): string | null {
  if (access === undefined) return null;
  if (access === null) return direction === "push" && creates ? null : "not found or no access";
  if (direction === "push" && !levelAtLeast(access.level, "write")) return "read-only";
  return null;
}

/** A few words for a skipped target, from the error that denied it. */
function shortReason(err: unknown, direction: "pull" | "push"): string {
  const message = err instanceof Error ? err.message : "";
  if (/^No access to /.test(message)) return "no access";
  return direction === "push" && /write/i.test(message) ? "read-only" : "not allowed";
}

/** Sync every (or the named) target of the nearest envvault.json / envvault.toml. */
export async function syncTree(
  direction: "pull" | "push",
  names: string[],
  opts: TreeSyncOptions,
): Promise<void> {
  const loaded = loadTreeTargets(process.cwd(), opts.config);
  if (!loaded) {
    throw new Error(
      "No envvault.json or envvault.toml here or in a parent directory. Create one with `envvault tree init`.",
    );
  }
  let targets = filterTargets(loaded.targets, names);
  const base = loadConfig();
  const config = loaded.treeFile.config.remote ? { ...base, remote: loaded.treeFile.config.remote } : base;
  const loggedIn = (() => {
    try {
      requireSession(config);
      return true;
    } catch {
      return false;
    }
  })();
  if (!opts.dryRun) requireSession(config);

  if (opts.interactive) {
    const picked = await pickTargets(direction, targets, config, loggedIn, opts.tenant ?? opts.workspace);
    if (!picked?.length) {
      info(picked ? "Nothing selected." : "Cancelled.");
      return;
    }
    targets = picked;
  }

  hint(`${plural(targets.length, "target")} from ${rel(loaded.treeFile.path)}`);
  const tenantCache = new Map<string | undefined, Promise<string>>();
  const access = opts.dryRun && loggedIn ? await loadTargetAccess(config, targets, opts.tenant ?? opts.workspace) : new Map();
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  const skip = (label: string, reason: string) => {
    skipped++;
    info(`${c.yellow("–")} skipped ${label}  ${c.dim(reason)}`);
  };

  const syncOne = async (t: TreeTarget) => {
    const label = `${c.bold(t.name)} ${c.dim(`(${t.project}/${t.env})`)}`;
    try {
      if (opts.dryRun) {
        const missing = direction === "push" && access.get(t) === null;
        if (missing && (opts.create || t.create)) {
          info(`${c.dim("[dry-run]")} push ${label} ← ${rel(t.file)}  ${c.green("would create it if it doesn't exist")}`);
          return;
        }
        const blocked = blockedBy(access.get(t), direction);
        if (blocked && opts.skipDenied) return skip(label, `${blocked}: would be skipped`);
        info(
          `${c.dim("[dry-run]")} ${direction} ${label} ${direction === "pull" ? "→" : "←"} ${rel(t.file)}` +
            (blocked ? `  ${c.red(`${blocked}: this would fail`)}` : ""),
        );
        if (blocked) failed++;
        return;
      }
      const tenantArg = opts.tenant ?? opts.workspace ?? t.tenant;
      if (!tenantCache.has(tenantArg)) tenantCache.set(tenantArg, resolveTenantArg(config, tenantArg));
      const tenantId = await tenantCache.get(tenantArg)!;
      if (direction === "pull") {
        const { keys } = await pullTarget(config, { ...t, tenantId, groups: opts.groups });
        success(`pulled ${plural(keys, "var")} → ${rel(t.file)}  ${label}`);
      } else {
        const { keys, created, markersIgnored } = await pushTarget(config, {
          ...t,
          tenantId,
          create: opts.create || t.create,
          groups: opts.groups,
        });
        success(`pushed ${plural(keys, "var")} ← ${rel(t.file)}  ${label}${created ? `  ${c.green(`(created ${created})`)}` : ""}`);
        if (markersIgnored) hint(MARKERS_IGNORED);
      }
      synced++;
    } catch (err) {
      if (opts.skipDenied && isDenied(err)) return skip(label, shortReason(err, direction));
      failed++;
      console.error(`${c.red("✗")} ${label}: ${messageOf(err)}`);
    }
  };

  // A small pool overlaps hub round-trips without hammering the server.
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) await syncOne(t);
    }),
  );

  if (skipped || failed) {
    const parts = [
      opts.dryRun ? undefined : `${synced} synced`,
      skipped ? `${skipped} skipped` : undefined,
      failed ? `${failed} failed` : undefined,
    ].filter(Boolean);
    (failed ? console.error : console.log)(parts.join(", ") + ".");
  }
  if (!failed && skipped && !synced && !opts.dryRun) {
    warn("Nothing was synced: every target was skipped.");
  }
  if (failed) {
    if (!opts.skipDenied) hint("Targets you may not open can be skipped with --skip-denied.");
    process.exit(1);
  }
}

/** Let the user tick which targets to sync, annotated with what is known about each. */
async function pickTargets(
  direction: "pull" | "push",
  targets: TreeTarget[],
  config: EnvVaultConfig,
  loggedIn: boolean,
  tenant?: string,
): Promise<TreeTarget[] | null> {
  if (!process.stdin.isTTY) {
    throw new Error("--interactive needs a terminal. Name the targets instead, e.g. `envvault tree pull web api`.");
  }
  const access = loggedIn ? await loadTargetAccess(config, targets, tenant) : new Map<TreeTarget, TargetAccess>();
  const choices = targets.map((t) => {
    const notes = [`${t.project}/${t.env}`];
    const blocked = blockedBy(access.get(t), direction, t.create);
    if (blocked) notes.push(c.red(blocked));
    else if (direction === "push" && t.create && access.get(t) === null) notes.push(c.green("new: push creates it"));
    if (direction === "push" && !existsSync(t.file)) notes.push(c.yellow("no file yet"));
    return { label: t.name, hint: notes.join("  "), value: t };
  });
  return selectMany(`Which targets do you want to ${direction}?`, choices);
}

/**
 * Whether a bare `pull`/`push` should sync the whole tree: run from the directory holding
 * envvault.json/toml, with several targets, and nothing on the command line narrowing it.
 */
export function wantsWholeTree(narrowed: boolean, all: boolean): boolean {
  if (narrowed) return false;
  const loaded = loadTreeTargets();
  if (!loaded?.treeFile.config.tree) return false;
  if (all) return true;
  return loaded.targets.length > 1 && resolve(process.cwd()) === loaded.treeFile.dir;
}
