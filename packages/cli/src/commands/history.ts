import type { Command } from "commander";
import { diffEnv, serializeEnv } from "@envvault/shared";
import { hubGetEnv } from "../remote.js";
import { hubDeleteVersion, hubHistory, hubReadVersion, hubRestoreVersion } from "../ops.js";
import { confirmAction } from "../cli/prompt.js";
import { asTarget, resolveTarget, withTarget } from "../cli/target.js";
import { c, hint, info, plural, printJson, printTable, success, when } from "../ui.js";

type Opts = {
  project?: string;
  env?: string;
  tenant?: string;
  json?: boolean;
  yes?: boolean;
  diff?: boolean;
  values?: boolean;
};

function versionNumber(raw: string): number {
  const n = Number(raw.replace(/^v/i, ""));
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${raw}" isn't a version number (try 3 or v3).`);
  return n;
}

async function list(opts: Opts): Promise<void> {
  const t = await resolveTarget(opts);
  const h = await hubHistory(asTarget(t));
  if (opts.json) return printJson(h);
  info(`${c.bold(`${t.project}/${t.env}`)}  ${c.dim(`current version ${h.current.version}`)}`);
  printTable(
    ["VERSION", "SAVED", "BY", "NOTE"],
    [
      [`v${h.current.version} ${c.green("(current)")}`, when(h.current.updatedAt), h.current.updatedBy, h.current.note],
      ...h.history.map((v) => [`v${v.version}`, when(v.createdAt), v.createdBy, v.note]),
    ],
  );
  if (!h.history.length) hint("No earlier versions yet: each save keeps the one it replaces.");
}

export function registerHistory(program: Command): void {
  const history = program
    .command("history")
    .description("Browse, compare, restore or delete an environment's earlier versions");

  withTarget(history.command("list").alias("ls").description("List saved versions (the default)"))
    .option("--json", "Machine-readable output")
    .action((opts: Opts) => list(opts));

  withTarget(
    history
      .command("show")
      .description("Print an earlier version (or, with --diff, what restoring it would change)")
      .argument("<version>", "Version number (e.g. 3 or v3)"),
  )
    .option("--diff", "Compare with the current environment instead of printing it")
    .option("--values", "With --diff, show values too (hidden by default)")
    .action(async (raw: string, opts: Opts) => {
      const version = versionNumber(raw);
      const t = await resolveTarget(opts);
      const { env } = await hubReadVersion(asTarget(t), version);
      if (!opts.diff) {
        process.stdout.write(serializeEnv(env));
        return;
      }
      const current = await hubGetEnv(t.config, t.project, t.env, t.tenantId);
      const changes = diffEnv(current.env, env);
      if (!changes.length) return info(`v${version} is identical to the current environment.`);
      info(c.dim(`Restoring v${version} over the current environment would:`));
      for (const ch of changes) {
        const mark = ch.kind === "added" ? c.green("+ add   ") : ch.kind === "removed" ? c.red("- remove ") : c.yellow("~ change ");
        const detail = !opts.values
          ? ""
          : ch.kind === "added"
            ? `  ${ch.version}`
            : ch.kind === "removed"
              ? `  ${ch.current}`
              : `  ${ch.current} → ${ch.version}`;
        info(`${mark}${ch.key}${detail}`);
      }
      hint(`${plural(changes.length, "difference")}. Apply with \`envvault history restore ${version}\`.`);
    });

  withTarget(
    history
      .command("restore")
      .description("Save an earlier version as the new current one (the old one stays in history)")
      .argument("<version>", "Version number (e.g. 3 or v3)"),
  )
    .option("-y, --yes", "Skip the confirmation")
    .action(async (raw: string, opts: Opts) => {
      const version = versionNumber(raw);
      const t = await resolveTarget(opts);
      const ok = await confirmAction(`Replace ${t.project}/${t.env} with version ${version}?`, opts.yes);
      if (!ok) return info("Cancelled.");
      const { keys } = await hubRestoreVersion(asTarget(t), version);
      success(`Restored v${version} (${plural(keys, "var")}) as a new version of ${c.bold(`${t.project}/${t.env}`)}`);
    });

  withTarget(
    history
      .command("delete")
      .description("Delete one saved version (needs the delete permission)")
      .argument("<version>", "Version number (e.g. 3 or v3)"),
  )
    .option("-y, --yes", "Skip the confirmation")
    .action(async (raw: string, opts: Opts) => {
      const version = versionNumber(raw);
      const t = await resolveTarget(opts);
      const ok = await confirmAction(`Delete version ${version} of ${t.project}/${t.env}? It can't be recovered.`, opts.yes);
      if (!ok) return info("Cancelled.");
      await hubDeleteVersion(asTarget(t), version);
      success(`Deleted v${version}`);
    });

  // `envvault history` alone lists, like `history list`.
  withTarget(history).option("--json", "Machine-readable output").action((opts: Opts) => list(opts));
}
