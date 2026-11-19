import { DEFAULT_ENV_NAME } from "@envvault/shared";
import type { EnvVaultConfig } from "./config.js";
import {
  loadTreeFile,
  resolveTargets,
  targetForDir,
  type TreeFile,
  type TreeTarget,
} from "./tree.js";
import { resolve } from "node:path";

/** What a command was told on its own command line. */
export type TargetFlags = {
  project?: string;
  env?: string;
  tenant?: string;
  /** `--workspace`: another name for `tenant`. */
  workspace?: string;
  file?: string;
  merge?: boolean;
  create?: boolean;
};

/** Where a command acts: flags first, then the nearest config's node for this directory. */
export type Context = {
  project?: string;
  env: string;
  tenant?: string;
  /** Absolute path of the env file (default `.env` next to the config node, or in cwd). */
  file: string;
  merge: boolean;
  /** Push creates a missing project / environment. */
  create: boolean;
  /** The config file that supplied settings, and which target of it. */
  source?: { path: string; target?: string };
};

/** Tree-wide targets the config defines, or null when there is no multi-target tree. */
export function loadTreeTargets(
  cwd = process.cwd(),
  configPath?: string,
): { treeFile: TreeFile; targets: TreeTarget[] } | null {
  const treeFile = loadTreeFile(cwd, configPath);
  if (!treeFile) return null;
  return { treeFile, targets: resolveTargets(treeFile) };
}

/**
 * Settings for one command. Precedence: command-line flags, then the config node for the
 * current directory (or the config's root settings), then your saved defaults.
 */
export function resolveContext(
  flags: TargetFlags,
  config: EnvVaultConfig,
  cwd = process.cwd(),
): Context {
  let node: TreeTarget | undefined;
  let treeFile: TreeFile | null = null;
  try {
    treeFile = loadTreeFile(cwd);
    if (treeFile?.config.tree) node = targetForDir(resolveTargets(treeFile), cwd);
  } catch {
    /* a broken tree is reported by the tree commands; plain commands fall back to the root */
  }
  const root = treeFile?.config;

  const project = flags.project ?? node?.project ?? root?.project ?? config.defaultProject;
  const env = (flags.env ?? node?.env ?? root?.env ?? config.defaultEnv ?? DEFAULT_ENV_NAME)
    .trim()
    .toLowerCase();
  const tenant = flags.tenant ?? flags.workspace ?? node?.tenant ?? root?.tenant;
  const file = flags.file
    ? resolve(cwd, flags.file)
    : node?.file ?? resolve(treeFile?.dir ?? cwd, root?.file ?? ".env");
  const merge = flags.merge ?? node?.merge ?? root?.merge ?? false;
  const create = flags.create ?? node?.create ?? root?.create ?? false;

  return {
    project,
    env,
    tenant,
    file,
    merge,
    create,
    source: treeFile ? { path: treeFile.path, target: node?.name } : undefined,
  };
}

/** The project to act on, or an error that says how to set one. */
export function requireProject(ctx: Context): string {
  if (ctx.project) return ctx.project;
  throw new Error(
    "No project chosen. Pass -p <name>, run inside a directory with an envvault.toml / " +
      "envvault.json that sets one, or save a default with `envvault init -d <name>`.",
  );
}
