import type { Command } from "commander";
import { loadConfig, requireSession, type EnvVaultConfig } from "../config.js";
import { requireProject, resolveContext, type Context, type TargetFlags } from "../context.js";
import { resolveTenantArg } from "./helpers.js";

/** The -p / -e / -t trio every environment command shares. */
export function withTarget(cmd: Command, opts: { env?: boolean } = {}): Command {
  cmd.option("-p, --project <name>", "Project (default: from envvault.toml/json, else your saved default)");
  if (opts.env !== false) {
    cmd.option("-e, --env <name>", 'Environment (default: from envvault.toml/json, else "default")');
  }
  return cmd.option("-t, --tenant <idOrSlug>", "Workspace (default: from config, else your active one)");
}

export type ResolvedTarget = {
  config: EnvVaultConfig;
  ctx: Context;
  project: string;
  env: string;
  tenantId: string;
};

/** Work out which project/environment/workspace a command acts on, and that you're logged in. */
export async function resolveTarget(flags: TargetFlags): Promise<ResolvedTarget> {
  const config = loadConfig();
  requireSession(config);
  const ctx = resolveContext(flags, config);
  const project = requireProject(ctx);
  const tenantId = await resolveTenantArg(config, ctx.tenant);
  return { config, ctx, project, env: ctx.env, tenantId };
}

/** The `Target` shape the hub operations take. */
export const asTarget = (t: ResolvedTarget) => ({
  config: t.config,
  project: t.project,
  env: t.env,
  tenantId: t.tenantId,
});
