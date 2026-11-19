import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";

/** Config file names searched in the current directory (exactly one may exist). */
export const TREE_FILE_NAMES = ["envvault.json", "envvault.toml"] as const;

/** Settings that cascade from the root down through every node. */
export type TreeSettings = {
  tenant?: string;
  project?: string;
  env?: string;
  /** Env file, relative to the node's directory (default: ".env"). */
  file?: string;
  /** Pull only: merge into the existing file instead of overwriting. */
  merge?: boolean;
  /** Push only: create the project / environment on the hub when it doesn't exist yet. */
  create?: boolean;
};

export type TreeNode = TreeSettings & {
  /** Directory relative to the parent node (default: the node's key). */
  path?: string;
  /** `false` makes this node a pure grouping directory (not synced itself). */
  sync?: boolean;
  children?: Record<string, TreeNode>;
};

export type TreeConfig = TreeSettings & {
  remote?: string;
  tree?: Record<string, TreeNode>;
};

export type TreeFile = {
  path: string;
  dir: string;
  config: TreeConfig;
};

/** One resolved sync target: a directory/file bound to project + env. */
export type TreeTarget = {
  /** Slash-joined node keys, e.g. "apps/web". */
  name: string;
  dir: string;
  file: string;
  project: string;
  env: string;
  tenant?: string;
  merge: boolean;
  create: boolean;
};

const SETTING_KEYS = ["tenant", "project", "env", "file"] as const;

export function findTreeFile(dir: string): string | null {
  const found = TREE_FILE_NAMES.map((n) => join(dir, n)).filter(existsSync);
  if (found.length > 1) {
    throw new Error(
      `Multiple config files found (${found.join(", ")}). Keep only one.`,
    );
  }
  return found[0] ?? null;
}

/** The nearest config file in `start` or any parent directory (like git finds `.git`). */
export function findTreeFileUp(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const found = findTreeFile(dir);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function expectString(
  value: unknown,
  where: string,
  key: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${where}: "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function validateNode(raw: unknown, where: string): TreeNode {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: expected a table/object`);
  }
  const r = raw as Record<string, unknown>;
  const node: TreeNode = {};
  for (const key of [...SETTING_KEYS, "path"] as const) {
    const v = expectString(r[key], where, key);
    if (v !== undefined) node[key] = v;
  }
  // "workspace" is the name people use; the hub calls it a tenant. Accept either, never both.
  const workspace = expectString(r.workspace, where, "workspace");
  if (workspace !== undefined) {
    if (node.tenant !== undefined) throw new Error(`${where}: set "workspace" or "tenant", not both`);
    node.tenant = workspace;
  }
  for (const key of ["merge", "create", "sync"] as const) {
    if (r[key] === undefined) continue;
    if (typeof r[key] !== "boolean") {
      throw new Error(`${where}: "${key}" must be true or false`);
    }
    node[key] = r[key] as boolean;
  }
  if (r.children !== undefined) {
    node.children = validateNodes(r.children, `${where}.children`);
  }
  return node;
}

function validateNodes(raw: unknown, where: string): Record<string, TreeNode> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: expected a table/object of nodes`);
  }
  const out: Record<string, TreeNode> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = validateNode(value, `${where}.${key}`);
  }
  return out;
}

export function parseTreeConfig(text: string, format: "json" | "toml"): TreeConfig {
  const raw: unknown = format === "json" ? JSON.parse(text) : parseToml(text);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config root must be an object");
  }
  const r = raw as Record<string, unknown>;
  const root = validateNode({ ...r, tree: undefined, children: undefined }, "config");
  const config: TreeConfig = { ...root };
  delete (config as TreeNode).path;
  delete (config as TreeNode).sync;
  const remote = expectString(r.remote, "config", "remote");
  if (remote) config.remote = remote.replace(/\/$/, "");
  if (r.tree !== undefined) config.tree = validateNodes(r.tree, "tree");
  return config;
}

/**
 * Load the config from an explicit `file`, else the nearest envvault.json / envvault.toml in
 * `dir` or a parent. Null if there is none.
 */
export function loadTreeFile(dir: string, file?: string): TreeFile | null {
  const path = file ? resolve(dir, file) : findTreeFileUp(dir);
  if (!path) return null;
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
  const format = path.endsWith(".toml") ? "toml" : "json";
  try {
    const config = parseTreeConfig(readFileSync(path, "utf8"), format);
    return { path, dir: resolve(path, ".."), config };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${relative(dir, path) || path}: ${msg}`);
  }
}

/**
 * Walk the tree depth-first. Settings cascade parent → child; a node's `path`
 * (default: its key) is joined onto the parent's directory. With no `tree`,
 * the root itself is the single target.
 */
export function resolveTargets(treeFile: TreeFile): TreeTarget[] {
  const { config, dir } = treeFile;
  const targets: TreeTarget[] = [];

  const make = (
    name: string,
    nodeDir: string,
    s: TreeSettings,
    fallbackProject?: string,
  ): TreeTarget => {
    const project = s.project ?? fallbackProject;
    if (!project) {
      throw new Error(
        `Target "${name}": no project. Set "project" on it or at the config root.`,
      );
    }
    const file = s.file ?? ".env";
    return {
      name,
      dir: nodeDir,
      file: isAbsolute(file) ? file : join(nodeDir, file),
      project,
      env: (s.env ?? "default").toLowerCase(),
      tenant: s.tenant,
      merge: s.merge ?? false,
      create: s.create ?? false,
    };
  };

  const walk = (
    nodes: Record<string, TreeNode>,
    parentDir: string,
    parentName: string,
    inherited: TreeSettings,
  ): void => {
    for (const [key, node] of Object.entries(nodes)) {
      const nodeDir = resolve(parentDir, node.path ?? key);
      const name = parentName ? `${parentName}/${key}` : key;
      const settings: TreeSettings = { ...inherited };
      for (const k of SETTING_KEYS) if (node[k] !== undefined) settings[k] = node[k];
      if (node.merge !== undefined) settings.merge = node.merge;
      if (node.create !== undefined) settings.create = node.create;

      if (node.sync !== false) {
        // Nodes without an explicit project fall back to inheritance, then the key.
        targets.push(make(name, nodeDir, settings, settings.project ?? key));
      }
      if (node.children) walk(node.children, nodeDir, name, settings);
    }
  };

  const rootSettings: TreeSettings = {};
  for (const k of SETTING_KEYS) if (config[k] !== undefined) rootSettings[k] = config[k];
  if (config.merge !== undefined) rootSettings.merge = config.merge;
  if (config.create !== undefined) rootSettings.create = config.create;

  if (config.tree) {
    walk(config.tree, dir, "", rootSettings);
  } else {
    targets.push(make(".", dir, rootSettings));
  }
  return targets;
}

/** Match `.`-style names or plain keys; a prefix selects a whole subtree. */
export function filterTargets(targets: TreeTarget[], names: string[]): TreeTarget[] {
  if (!names.length) return targets;
  const picked = targets.filter((t) =>
    names.some((n) => t.name === n || t.name.startsWith(`${n}/`)),
  );
  const missing = names.filter(
    (n) => !targets.some((t) => t.name === n || t.name.startsWith(`${n}/`)),
  );
  if (missing.length) {
    throw new Error(
      `Unknown target(s): ${missing.join(", ")}. Known: ${targets.map((t) => t.name).join(", ")}`,
    );
  }
  return picked;
}

export const TREE_TEMPLATES = {
  json: `{
  "remote": "https://envvault.example.com",
  "workspace": "my-team",
  "project": "my-app",
  "env": "default",
  "create": true,
  "tree": {
    "root": { "path": ".", "file": ".env" },
    "web": {
      "path": "apps/web",
      "env": "staging",
      "children": {
        "api": { "path": "../api", "project": "my-api" }
      }
    }
  }
}
`,
  toml: `remote = "https://envvault.example.com"
workspace = "my-team"   # must already exist on the hub; the CLI never creates workspaces
project = "my-app"      # defaults cascade to every node below
env = "default"
create = true           # push creates a missing project / environment (omit to refuse instead)

[tree.root]
path = "."
file = ".env"

[tree.web]
path = "apps/web"
env = "staging"

[tree.web.children.api]
path = "../api"        # relative to the parent node's directory
project = "my-api"
`,
} as const;

const inside = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * The target a directory belongs to: the one whose directory is the deepest that still
 * contains `cwd`. Undefined when `cwd` is outside every target.
 */
export function targetForDir(targets: TreeTarget[], cwd: string): TreeTarget | undefined {
  const here = resolve(cwd);
  return targets
    .filter((t) => inside(t.dir, here))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}
