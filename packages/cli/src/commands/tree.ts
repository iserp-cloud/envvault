import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { filterTargets, findTreeFile, TREE_FILE_NAMES, TREE_TEMPLATES } from "../tree.js";
import { loadTreeTargets } from "../context.js";
import { loadTargetAccess, syncTree } from "./sync.js";
import { loadConfig } from "../config.js";
import { describeAccess } from "@envvault/shared";
import { c, hint, info, printJson, printTable, rel, success } from "../ui.js";

const CONFIG_OPTION = `Config file (default: the nearest ${TREE_FILE_NAMES.join(" / ")})`;

export function registerTree(program: Command): void {
  const tree = program
    .command("tree")
    .description(`Sync many env files from one ${TREE_FILE_NAMES.join(" / ")}`);

  tree
    .command("init")
    .description("Create an example envvault.toml (or .json) in this directory")
    .option("--format <fmt>", "toml or json", "toml")
    .option("--force", "Overwrite an existing config")
    .action((opts) => {
      const format = opts.format as string;
      if (format !== "json" && format !== "toml") throw new Error('--format must be "toml" or "json".');
      const existing = findTreeFile(process.cwd());
      if (existing && !opts.force) throw new Error(`${rel(existing)} already exists (use --force to overwrite).`);
      const path = resolve(`envvault.${format}`);
      writeFileSync(path, TREE_TEMPLATES[format]);
      success(`Created ${rel(path)}`);
      hint("Edit the project / env / paths, then run `envvault pull` here to sync every target.");
    });

  tree
    .command("list")
    .alias("ls")
    .description("Show every target and where it syncs")
    .argument("[targets...]", "Limit to these targets (a prefix selects a subtree)")
    .option("-c, --config <path>", CONFIG_OPTION)
    .option("--offline", "Don't ask the hub what you have access to")
    .option("--json", "Machine-readable output")
    .action(async (names: string[], opts) => {
      const loaded = loadTreeTargets(process.cwd(), opts.config as string | undefined);
      if (!loaded) throw new Error("No envvault.json or envvault.toml here or in a parent directory.");
      const targets = filterTargets(loaded.targets, names);

      // What you may do with each target, when logged in and the hub answers.
      const base = loadConfig();
      const config = loaded.treeFile.config.remote ? { ...base, remote: loaded.treeFile.config.remote } : base;
      const access = opts.offline ? new Map() : await loadTargetAccess(config, targets);
      const known = [...access.values()].some((a) => a !== undefined);
      const describe = (t: (typeof targets)[number]) => {
        const a = access.get(t);
        if (a === undefined) return "";
        return a === null ? c.red("no access") : describeAccess(a.level, a.caps);
      };

      if (opts.json) {
        return printJson({
          config: loaded.treeFile.path,
          targets: targets.map((t) => ({
            ...t,
            access: access.get(t) === undefined ? undefined : access.get(t) === null ? "none" : describe(t),
          })),
        });
      }
      info(`${c.dim("Config")} ${rel(loaded.treeFile.path)}`);
      printTable(
        known ? ["TARGET", "PROJECT/ENV", "WORKSPACE", "FILE", "ACCESS"] : ["TARGET", "PROJECT/ENV", "WORKSPACE", "FILE"],
        targets.map((t) => [
          t.name, `${t.project}/${t.env}`, t.tenant ?? "", rel(t.file), ...(known ? [describe(t)] : []),
        ]),
      );
      if (!opts.offline && !known) hint("Log in to see your access to each target.");
      else if (known && [...access.values()].some((a) => a === null)) {
        hint("Targets marked no access fail to sync; add --skip-denied to pull/push to skip them.");
      }
    });

  for (const direction of ["pull", "push"] as const) {
    tree
      .command(direction)
      .description(
        direction === "pull" ? "Pull every target's environment into its file" : "Push every target's file to its environment",
      )
      .argument("[targets...]", "Limit to these targets (a prefix selects a subtree)")
      .option("-c, --config <path>", CONFIG_OPTION)
      .option("-t, --tenant <idOrSlug>", "Workspace override for all targets")
      .option("-n, --dry-run", "Show what would happen, including targets you have no access to")
      .option("-i, --interactive", `Choose which targets to ${direction} from a list`)
      .option("--skip-denied", "Report targets you have no access to as skipped instead of failing")
      .action((names: string[], opts) => syncTree(direction, names, opts));
  }
}
