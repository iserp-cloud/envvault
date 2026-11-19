import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import tls from "node:tls";
import { join } from "node:path";
import { decodeServiceToken, type KdfParams, type SealedBox } from "@envvault/shared";
import { config as loadDotenv } from "dotenv";
import { loadTreeFile } from "./tree.js";
import { setTrustedFingerprint } from "./ui.js";

loadDotenv();

/** How the private key is kept at rest. Never plaintext. */
export type StoredKey =
  | { mode: "keychain"; sealed: SealedBox }
  | { mode: "password"; wrapped: SealedBox; kdf: KdfParams };

/** Logged-in hub session (dashboard-compatible). */
export type CliSession = {
  /** The hub this session belongs to; a different hub never receives its token. */
  remote?: string;
  token: string;
  username: string;
  publicKey: string;
  personalTenantId: string;
  activeTenantId: string;
  /** At-rest protected private key (persisted). */
  key?: StoredKey;
  /** Decrypted private key — memory only, never written to disk. */
  privateKey?: string;
  /** Password-sealed copy from the hub, used only to build `key` right after login (memory only). */
  passwordKey?: { wrapped: SealedBox; kdf: KdfParams };
};

/** Project-local overlay (no session — secrets stay global). */
export type ProjectConfig = {
  remote?: string;
  defaultProject?: string;
  defaultEnv?: string;
};

/** A certificate this computer was told to trust for one hub. */
export type TrustedCert = { kind: "pinned" | "ca"; pem: string; fingerprint: string };

export type EnvVaultConfig = ProjectConfig & {
  /**
   * Certificates trusted for a hub, by hub URL: a self-made hub certificate remembered on first
   * contact, or the authority you gave with `--ca`. Global config only: a repository's
   * envvault.toml must never be able to add one.
   */
  certs?: Record<string, TrustedCert>;
  /** Set (never saved) when the saved login belongs to a different hub than the one in use. */
  otherHub?: string;
  /** Remembered public-key fingerprints per hub, for trust-on-first-use (global only). */
  pins?: Record<string, Record<string, string>>;
  /** Active user session after `envvault login` (global only) */
  session?: CliSession;
};

export type ConfigScope = "global" | "project";

function xdgConfigHome(): string {
  if (process.env.XDG_CONFIG_HOME?.trim()) {
    return process.env.XDG_CONFIG_HOME.trim();
  }
  if (process.platform === "win32") {
    return process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
  }
  return join(homedir(), ".config");
}

/** Global config directory: ~/.config/envvault (or $XDG_CONFIG_HOME/envvault). */
export function getGlobalConfigDir(): string {
  if (process.env.ENVVAULT_CONFIG_DIR?.trim()) {
    return process.env.ENVVAULT_CONFIG_DIR.trim();
  }
  return join(xdgConfigHome(), "envvault");
}

export function getGlobalConfigPath(): string {
  return join(getGlobalConfigDir(), "config.json");
}

/** Optional per-project overlay under the current working directory. */
export function getProjectConfigDir(): string {
  return join(process.cwd(), ".envvault");
}

export function getProjectConfigPath(): string {
  return join(getProjectConfigDir(), "config.json");
}

/** @deprecated Prefer getGlobalConfigDir / getProjectConfigDir */
export function getConfigDir(): string {
  return getGlobalConfigDir();
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, dir: string, data: unknown): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

function asConfig(raw: Record<string, unknown> | null): EnvVaultConfig {
  if (!raw) return {};
  return raw as EnvVaultConfig;
}

function projectFields(config: EnvVaultConfig): ProjectConfig {
  const out: ProjectConfig = {};
  if (config.remote !== undefined) out.remote = config.remote;
  if (config.defaultProject !== undefined) {
    out.defaultProject = config.defaultProject;
  }
  if (config.defaultEnv !== undefined) out.defaultEnv = config.defaultEnv;
  return out;
}

/**
 * One-time: if cwd still has a legacy .envvault/config.json with a session and
 * global has none, move the session (and missing defaults) into the global file.
 * Leaves project overlay without session secrets.
 */
function migrateLegacyProjectConfig(): void {
  const projectPath = getProjectConfigPath();
  const globalPath = getGlobalConfigPath();
  const legacy = asConfig(readJsonFile(projectPath));
  if (!legacy.session) return;

  const global = asConfig(readJsonFile(globalPath));
  if (!global.session) {
    writeJsonFile(globalPath, getGlobalConfigDir(), {
      ...global,
      remote: global.remote ?? legacy.remote,
      defaultProject: global.defaultProject ?? legacy.defaultProject,
      defaultEnv: global.defaultEnv ?? legacy.defaultEnv,
      session: legacy.session,
    });
  }

  // Strip secrets from the project file; keep local overrides only.
  writeJsonFile(projectPath, getProjectConfigDir(), projectFields(legacy));
}

/** Hub URLs are compared and stored without a trailing slash. */
export function normalizeRemote(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    // No scheme: a hub on this machine is http, anything else https.
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(raw);
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${local ? "http" : "https"}://${raw}`);
  } catch {
    throw new Error(`"${input}" is not a valid hub URL. Example: https://envvault.example.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Hub URL must start with https:// or http:// (got ${url.protocol}//).`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** True for a hub on this machine, where plain http is fine. */
export function isLoopback(remote: string): boolean {
  const host = new URL(remote).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

let flagRemote: string | undefined;

/** `--remote <url>` for one command: wins over every config file and ENVVAULT_REMOTE. */
export function setRemoteFlag(url: string): void {
  flagRemote = normalizeRemote(url);
  process.env.ENVVAULT_REMOTE = flagRemote;
}

export type TlsState = {
  /** `--insecure` / ENVVAULT_INSECURE: nothing is verified (last resort, for one-off tests and CI). */
  insecure: boolean;
  /** The certificate trusted for the hub in use, if any. */
  trusted?: TrustedCert;
};

let state: TlsState = { insecure: false };
let skippedByUs = false;

export function tlsState(): TlsState {
  return state;
}

/** Whether this Node can add a certificate to its trusted list (22.19+ / 24.5+). */
export function canTrustCertificates(): boolean {
  return typeof tls.setDefaultCACertificates === "function";
}

export function getTrustedCert(remote: string): TrustedCert | undefined {
  try {
    return loadGlobalConfig().certs?.[normalizeRemote(remote)];
  } catch {
    return undefined; // a malformed URL is reported by the command itself
  }
}

export function saveTrustedCert(remote: string, cert: TrustedCert): void {
  const global = loadGlobalConfig();
  global.certs = { ...global.certs, [normalizeRemote(remote)]: cert };
  saveGlobalConfig(global);
}

export function forgetTrustedCert(remote: string): void {
  const url = normalizeRemote(remote);
  const global = loadGlobalConfig();
  if (!global.certs?.[url]) return;
  delete global.certs[url];
  if (!Object.keys(global.certs).length) delete global.certs;
  saveGlobalConfig(global);
}

let baselineCAs: string[] | undefined;
let extraCA: string | undefined;

/** Make exactly this certificate (or none) trusted on top of Node's normal list. */
function setExtraCA(pem: string | undefined): void {
  if (!canTrustCertificates() || pem === extraCA) return;
  baselineCAs ??= tls.getCACertificates("default");
  tls.setDefaultCACertificates(pem ? [...baselineCAs, pem] : baselineCAs);
  extraCA = pem;
}

/**
 * Set up TLS for the hub in use. A certificate saved for that hub (a pinned self-made one, or the
 * authority given with `--ca`) is added to the trusted list; every other hub is verified as usual.
 * `--insecure` or `ENVVAULT_INSECURE=1` skips verification altogether, for one-off tests and CI.
 */
export function applyTlsPolicy(opts: { flag?: boolean; remote?: string } = {}): TlsState {
  const insecure = Boolean(opts.flag) || /^(1|true|yes)$/i.test(process.env.ENVVAULT_INSECURE?.trim() ?? "");
  const trusted = opts.remote ? getTrustedCert(opts.remote) : undefined;
  state = { insecure, trusted };
  setTrustedFingerprint(trusted?.fingerprint);

  setExtraCA(insecure ? undefined : trusted?.pem);
  if (!insecure && skippedByUs) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; // an earlier setting in this run no longer applies
    skippedByUs = false;
  }
  if (insecure) {
    skippedByUs = true;
    // Node prints a long warning whenever this is set; the CLI says what matters itself.
    const emit = process.emitWarning;
    process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
      if (String(warning).includes("NODE_TLS_REJECT_UNAUTHORIZED")) return;
      return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  return state;
}

/** Which hub is in use and where that choice came from. */
export function remoteSource(): { url?: string; from: string } {
  if (flagRemote) return { url: flagRemote, from: "--remote flag" };
  const env = process.env.ENVVAULT_REMOTE?.trim();
  if (env) return { url: env.replace(/\/$/, ""), from: "ENVVAULT_REMOTE" };
  const tree = loadTreeFile(process.cwd());
  if (tree?.config.remote) return { url: tree.config.remote, from: tree.path };
  const project = asConfig(readJsonFile(getProjectConfigPath()));
  if (project.remote) return { url: project.remote, from: getProjectConfigPath() };
  const global = asConfig(readJsonFile(getGlobalConfigPath()));
  if (global.remote) return { url: global.remote, from: getGlobalConfigPath() };
  return { from: "not set" };
}

/** Effective config: global ← project overlay (remote / defaults only). */
export function loadConfig(): EnvVaultConfig {
  migrateLegacyProjectConfig();

  const global = asConfig(readJsonFile(getGlobalConfigPath()));
  const project = asConfig(readJsonFile(getProjectConfigPath()));
  const overlay = projectFields(project);

  // The nearest envvault.json / envvault.toml (here or in a parent directory) wins.
  const tree = loadTreeFile(process.cwd())?.config;
  const fromTree: ProjectConfig = {};
  if (tree?.remote) fromTree.remote = tree.remote;
  if (tree?.project) fromTree.defaultProject = tree.project;
  if (tree?.env) fromTree.defaultEnv = tree.env;

  const merged: EnvVaultConfig = {
    ...global,
    ...overlay,
    ...fromTree,
    session: global.session,
  };

  // CI: ENVVAULT_TOKEN (a service token) acts as a ready-made session for one workspace.
  const rawToken = process.env.ENVVAULT_TOKEN?.trim();
  if (rawToken) {
    let t: ReturnType<typeof decodeServiceToken>;
    try {
      t = decodeServiceToken(rawToken);
    } catch {
      throw new Error("ENVVAULT_TOKEN is not a valid EnvVault service token.");
    }
    merged.session = {
      token: t.t,
      username: t.u,
      publicKey: "",
      privateKey: t.k, // lives in the environment, never persisted
      personalTenantId: t.w,
      activeTenantId: t.w,
    };
    if (!process.env.ENVVAULT_REMOTE && !merged.remote) merged.remote = t.r;
  } else {
    // A saved login belongs to the hub it came from; never present its token to another one.
    const inUse = (process.env.ENVVAULT_REMOTE ?? merged.remote)?.replace(/\/$/, "");
    const owner = merged.session?.remote?.replace(/\/$/, "");
    if (merged.session && owner && inUse && owner !== inUse) {
      merged.otherHub = owner;
      delete merged.session;
    }
  }
  return merged;
}

/** Fingerprint pins for one hub. */
export function loadPins(remote: string): Record<string, string> {
  return loadGlobalConfig().pins?.[remote] ?? {};
}

export function savePin(remote: string, username: string, fingerprint: string): void {
  const global = loadGlobalConfig();
  global.pins = {
    ...global.pins,
    [remote]: { ...global.pins?.[remote], [username.toLowerCase()]: fingerprint },
  };
  saveGlobalConfig(global);
}

export function resetPins(remote: string): void {
  const global = loadGlobalConfig();
  if (global.pins) delete global.pins[remote];
  saveGlobalConfig(global);
}

export function loadGlobalConfig(): EnvVaultConfig {
  migrateLegacyProjectConfig();
  return asConfig(readJsonFile(getGlobalConfigPath()));
}

export function saveGlobalConfig(config: EnvVaultConfig): void {
  // Defence in depth: the decrypted key must never reach disk, whatever the caller passes.
  const { session, ...rest } = config;
  const safe: EnvVaultConfig = { ...rest };
  if (session) {
    const { privateKey: _a, passwordKey: _b, ...persisted } = session;
    safe.session = persisted;
  }
  writeJsonFile(getGlobalConfigPath(), getGlobalConfigDir(), safe);
}

export function saveProjectConfig(config: ProjectConfig): void {
  writeJsonFile(getProjectConfigPath(), getProjectConfigDir(), projectFields(config));
}

/**
 * Persist updates.
 * - `session` always written to the global config.
 * - remote / defaultProject / defaultEnv go to `scope` (default: global).
 */
export function updateConfig(
  partial: Partial<EnvVaultConfig>,
  opts?: { scope?: ConfigScope },
): EnvVaultConfig {
  const scope = opts?.scope ?? "global";
  const global = loadGlobalConfig();

  if ("session" in partial) {
    if (partial.session === undefined) {
      delete global.session;
    } else {
      global.session = partial.session;
    }
  }

  const projectPartial = projectFields(partial);

  if (scope === "global") {
    Object.assign(global, projectPartial);
    saveGlobalConfig(global);
  } else {
    saveGlobalConfig(global);
    const existing = projectFields(asConfig(readJsonFile(getProjectConfigPath())));
    saveProjectConfig({ ...existing, ...projectPartial });
  }

  return loadConfig();
}

export function clearSession(): EnvVaultConfig {
  const global = loadGlobalConfig();
  delete global.session;
  saveGlobalConfig(global);
  return loadConfig();
}

export function requireRemote(config = loadConfig()): string {
  const remote = process.env.ENVVAULT_REMOTE ?? config.remote;
  if (!remote) {
    throw new Error(
      "No hub configured. Run `envvault remote set <url>`, pass --remote <url>, or set ENVVAULT_REMOTE.",
    );
  }
  return remote.replace(/\/$/, "");
}

export function requireSession(config = loadConfig()): CliSession {
  const session = config.session;
  if (!session?.token || (!session.privateKey && !session.key)) {
    if (config.otherHub) {
      throw new Error(
        `Not logged in to this hub. Your saved login is for ${config.otherHub}, not ${requireRemote(config)}. Run \`envvault login\` here.`,
      );
    }
    throw new Error("Not logged in. Run `envvault login <username>`.");
  }
  return session;
}

export function describeConfigPaths(): {
  global: string;
  project: string;
} {
  return {
    global: getGlobalConfigPath(),
    project: getProjectConfigPath(),
  };
}
