import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { mergeEnv, parseEnv, serializeEnv, type EnvMap } from "@envvault/shared";
import { hubGetEnv, hubSaveEnv, isDenied } from "../remote.js";
import { confirmAction } from "../cli/prompt.js";
import { resolveTarget, withTarget } from "../cli/target.js";
import { pullTarget, pushTarget, syncTree, wantsWholeTree } from "./sync.js";
import { c, hint, info, messageOf, plural, rel, success } from "../ui.js";

type SyncOpts = {
  project?: string;
  env?: string;
  tenant?: string;
  file?: string;
  merge?: boolean;
  all?: boolean;
  yes?: boolean;
  skipDenied?: boolean;
};

const SKIP_DENIED = "Report targets you have no access to as skipped instead of failing";

/** Run a single-target sync; with --skip-denied a denial is reported and the command still succeeds. */
async function orSkip(skipDenied: boolean | undefined, label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!skipDenied || !isDenied(err)) throw err;
    info(`${c.yellow("–")} skipped ${label}  ${c.dim(err instanceof Error ? messageOf(err) : "not allowed")}`);
  }
}

const narrowed = (projectArg: string | undefined, o: SyncOpts) =>
  Boolean(projectArg || o.project || o.env || o.file);

export function registerData(program: Command): void {
  withTarget(
    program
      .command("pull")
      .description("Download an environment into a .env file (the whole tree, from a config root)")
      .argument("[project]", "Project name (same as -p)")
      .option("-f, --file <path>", "Output file (default: .env, or the file set in your config)")
      .option("--merge", "Merge into the existing file instead of replacing it")
      .option("--all", "Pull every target in envvault.toml/json, from any directory below it")
      .option("--skip-denied", SKIP_DENIED),
  ).action(async (projectArg: string | undefined, opts: SyncOpts) => {
    if (wantsWholeTree(narrowed(projectArg, opts), Boolean(opts.all))) {
      return syncTree("pull", [], { tenant: opts.tenant, skipDenied: opts.skipDenied });
    }
    const t = await resolveTarget({ ...opts, project: opts.project ?? projectArg });
    const ctx = { ...t.ctx, merge: opts.merge ?? t.ctx.merge };
    await orSkip(opts.skipDenied, `${t.project}/${t.env}`, async () => {
      const { keys } = await pullTarget(t.config, {
        project: t.project, env: t.env, file: ctx.file, merge: ctx.merge, tenantId: t.tenantId,
      });
      success(`Pulled ${plural(keys, "var")} → ${rel(ctx.file)}  ${c.dim(`(${t.project}/${t.env})`)}`);
    });
  });

  withTarget(
    program
      .command("push")
      .description("Upload a .env file to an environment (the whole tree, from a config root)")
      .argument("[project]", "Project name (same as -p)")
      .option("-f, --file <path>", "Source file (default: .env, or the file set in your config)")
      .option("--all", "Push every target in envvault.toml/json, from any directory below it")
      .option("-y, --yes", "Don't ask before pushing an empty file")
      .option("--skip-denied", SKIP_DENIED),
  ).action(async (projectArg: string | undefined, opts: SyncOpts) => {
    if (wantsWholeTree(narrowed(projectArg, opts), Boolean(opts.all))) {
      return syncTree("push", [], { tenant: opts.tenant, skipDenied: opts.skipDenied });
    }
    const t = await resolveTarget({ ...opts, project: opts.project ?? projectArg });
    if (!existsSync(t.ctx.file)) throw new Error(`File not found: ${rel(t.ctx.file)}`);
    if (!Object.keys(parseEnv(readFileSync(t.ctx.file, "utf8"))).length) {
      const ok = await confirmAction(
        `${rel(t.ctx.file)} has no variables, so this would empty ${t.project}/${t.env}. Continue?`,
        opts.yes,
      );
      if (!ok) return hint("Cancelled.");
    }
    await orSkip(opts.skipDenied, `${t.project}/${t.env}`, async () => {
      const { keys, updatedAt } = await pushTarget(t.config, {
        project: t.project, env: t.env, file: t.ctx.file, tenantId: t.tenantId,
      });
      success(`Pushed ${plural(keys, "var")} ← ${rel(t.ctx.file)}  ${c.dim(`(${t.project}/${t.env}, ${updatedAt})`)}`);
    });
  });

  withTarget(
    program
      .command("set")
      .description("Add or change KEY=VALUE pairs in an environment")
      .argument("<pairs...>", "KEY=VALUE pairs"),
  ).action(async (pairs: string[], opts: SyncOpts) => {
    const overlay: EnvMap = {};
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq < 1) throw new Error(`Expected KEY=VALUE, got "${pair}".`);
      overlay[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const t = await resolveTarget(opts);
    const current = await hubGetEnv(t.config, t.project, t.env, t.tenantId);
    await hubSaveEnv(t.config, t.project, t.env, mergeEnv(current.env, overlay), t.tenantId, current.updatedAt);
    success(`Set ${plural(Object.keys(overlay).length, "key")} in ${c.bold(`${t.project}/${t.env}`)}`);
  });

  withTarget(
    program
      .command("unset")
      .description("Remove keys from an environment")
      .argument("<keys...>", "Keys to remove"),
  ).action(async (keys: string[], opts: SyncOpts) => {
    const t = await resolveTarget(opts);
    const current = await hubGetEnv(t.config, t.project, t.env, t.tenantId);
    const missing = keys.filter((k) => !(k in current.env));
    if (missing.length === keys.length) {
      throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in ${t.project}/${t.env}.`);
    }
    const next = { ...current.env };
    for (const k of keys) delete next[k];
    await hubSaveEnv(t.config, t.project, t.env, next, t.tenantId, current.updatedAt);
    success(`Removed ${plural(keys.length - missing.length, "key")} from ${c.bold(`${t.project}/${t.env}`)}`);
    if (missing.length) hint(`Not present: ${missing.join(", ")}`);
  });

  withTarget(
    program
      .command("get")
      .description("Print one key's value, or the whole environment as .env text")
      .argument("[key]", "Key to print"),
  ).action(async (key: string | undefined, opts: SyncOpts) => {
    const t = await resolveTarget(opts);
    const loaded = await hubGetEnv(t.config, t.project, t.env, t.tenantId);
    if (!key) {
      process.stdout.write(serializeEnv(loaded.env));
      return;
    }
    if (!(key in loaded.env)) throw new Error(`Key "${key}" isn't in ${t.project}/${t.env}.`);
    console.log(loaded.env[key]);
  });
}
