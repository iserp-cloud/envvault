import type { Command } from "commander";
import { describeAccess } from "@envvault/shared";
import { hubCreateEnv, hubListEnvironments } from "../remote.js";
import { hubDeleteEnv } from "../ops.js";
import { confirmAction } from "../cli/prompt.js";
import { asTarget, resolveTarget, withTarget } from "../cli/target.js";
import { c, hint, info, printJson, printTable, success, when } from "../ui.js";

type Opts = { project?: string; tenant?: string; json?: boolean; yes?: boolean; env?: string };

/** Shared by `env list` and `list --envs`. */
export async function listEnvironmentsCommand(opts: Opts): Promise<void> {
  const t = await resolveTarget({ project: opts.project, tenant: opts.tenant });
  const { accessible, listed, unwrapFailed } = await hubListEnvironments(t.config, t.project, t.tenantId);
  if (opts.json) return printJson(accessible.map(({ envDek: _k, wrappedEnvDek: _w, ...rest }) => rest));
  if (!accessible.length) {
    info(listed.length ? "(no environments you can open)" : "(no environments)");
    return;
  }
  printTable(
    ["ENVIRONMENT", "ACCESS", "UPDATED"],
    accessible.map((e) => [e.name, describeAccess(e.level, e.caps ?? ""), when(e.updatedAt)]),
  );
  if (unwrapFailed.length) hint(`Couldn't open: ${unwrapFailed.join(", ")} (ask for access to be granted again).`);
}

export function registerEnv(program: Command): void {
  const env = program.command("env").description("List, create or delete a project's environments");

  withTarget(env.command("list").alias("ls").description("List a project's environments"), { env: false })
    .option("--json", "Machine-readable output")
    .action((opts: Opts) => listEnvironmentsCommand(opts));

  withTarget(
    env.command("create").description("Create an empty environment").argument("<name>", "Environment name"),
    { env: false },
  ).action(async (name: string, opts: Opts) => {
    const t = await resolveTarget({ project: opts.project, tenant: opts.tenant });
    const created = await hubCreateEnv(t.config, t.project, name, t.tenantId);
    success(`Created environment ${c.bold(`${t.project}/${created.name}`)}`);
    hint(`Fill it with \`envvault push -p ${t.project} -e ${created.name}\`.`);
  });

  withTarget(
    env.command("delete").description("Delete an environment and its history (irreversible)").argument("<name>", "Environment name"),
    { env: false },
  )
    .option("-y, --yes", "Skip the confirmation")
    .action(async (name: string, opts: Opts) => {
      const t = await resolveTarget({ project: opts.project, tenant: opts.tenant, env: name });
      const ok = await confirmAction(
        `Delete ${t.project}/${t.env} and its version history? This can't be undone.`,
        opts.yes,
      );
      if (!ok) return info("Cancelled.");
      await hubDeleteEnv(asTarget(t));
      success(`Deleted environment ${c.bold(`${t.project}/${t.env}`)}`);
    });
}
