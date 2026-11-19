import type { Command } from "commander";
import { loadConfig, requireSession, updateConfig } from "../config.js";
import { hubCreateProject, hubListProjects, hubListTenants } from "../remote.js";
import { hubDeleteProject } from "../ops.js";
import { resolveContext } from "../context.js";
import { listEnvironmentsCommand } from "./env.js";
import { resolveTenantArg } from "../cli/helpers.js";
import { confirmTyped } from "../cli/prompt.js";
import { c, hint, info, printJson, printTable, success, when } from "../ui.js";

export function registerWorkspace(program: Command): void {
  program
    .command("tenants")
    .alias("workspaces")
    .description("List the workspaces you belong to (* is active)")
    .option("--json", "Machine-readable output")
    .action(async (opts) => {
      const config = loadConfig();
      const session = requireSession(config);
      const tenants = await hubListTenants(config);
      if (opts.json) return printJson(tenants);
      if (!tenants.length) return info("(no workspaces)");
      printTable(
        ["", "WORKSPACE", "KIND", "ROLE", "ID"],
        tenants.map((t) => [t.id === session.activeTenantId ? "*" : " ", t.slug, t.kind, t.role, t.id]),
      );
    });

  program
    .command("use")
    .description("Switch the active workspace (slug, id, or `personal`)")
    .argument("<workspace>", "Workspace slug or id")
    .action(async (tenantArg: string) => {
      if (process.env.ENVVAULT_TOKEN) {
        throw new Error("`use` doesn't apply to service tokens (they belong to one workspace).");
      }
      const config = loadConfig();
      const session = requireSession(config);
      const tenantId = await resolveTenantArg(config, tenantArg);
      const match = (await hubListTenants(config)).find((t) => t.id === tenantId)!;
      updateConfig({ session: { ...session, activeTenantId: match.id } });
      success(`Active workspace: ${c.bold(match.slug)} (${match.kind})`);
    });

  program
    .command("list")
    .alias("ls")
    .description("List projects (or environments with --envs)")
    .option("-t, --tenant <idOrSlug>", "Workspace (default: from config, else active)")
    .option("-p, --project <name>", "Project (with --envs)")
    .option("--envs", "List environments of a project instead")
    .option("--json", "Machine-readable output")
    .action(async (opts) => {
      if (opts.envs) {
        return listEnvironmentsCommand(opts);
      }
      const config = loadConfig();
      requireSession(config);
      const ctx = resolveContext({ tenant: opts.tenant as string | undefined }, config);
      const tenantId = await resolveTenantArg(config, ctx.tenant);
      const projects = await hubListProjects(config, tenantId);
      if (opts.json) return printJson(projects);
      if (!projects.length) {
        info("(no projects)");
        hint("Create one with `envvault project create <name>`.");
        return;
      }
      printTable(
        ["PROJECT", "ACCESS", "UPDATED"],
        projects.map((p) => [p.name, p.level, when(p.updatedAt)]),
      );
    });

  const project = program.command("project").description("Create or delete projects");

  project
    .command("create")
    .description("Create a project (with a `default` environment)")
    .argument("<name>", "Project name")
    .option("-t, --tenant <idOrSlug>", "Workspace (default: from config, else active)")
    .action(async (name: string, opts) => {
      const config = loadConfig();
      requireSession(config);
      const ctx = resolveContext({ tenant: opts.tenant as string | undefined }, config);
      const tenantId = await resolveTenantArg(config, ctx.tenant);
      const created = await hubCreateProject(config, name, tenantId);
      success(`Created project ${c.bold(created.name)} with a default environment`);
      if (!config.defaultProject) {
        updateConfig({ defaultProject: created.name });
        hint(`Saved "${created.name}" as your default project.`);
      }
    });

  project
    .command("delete")
    .description("Delete a project and everything in it (irreversible)")
    .argument("<name>", "Project name")
    .option("-t, --tenant <idOrSlug>", "Workspace (default: from config, else active)")
    .option("-y, --yes", "Skip the confirmation")
    .action(async (name: string, opts) => {
      const config = loadConfig();
      requireSession(config);
      const ctx = resolveContext({ tenant: opts.tenant as string | undefined }, config);
      const tenantId = await resolveTenantArg(config, ctx.tenant);
      const ok = await confirmTyped(
        `This permanently deletes "${name}", all of its environments and their version history.`,
        name,
        opts.yes as boolean | undefined,
      );
      if (!ok) return info("Cancelled.");
      await hubDeleteProject(config, name, tenantId);
      success(`Deleted project ${c.bold(name)}`);
    });
}
