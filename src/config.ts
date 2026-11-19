import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv();

export type EnvVaultConfig = {
  /** Absolute path to the SQLite vault database */
  dbPath?: string;
};

const CONFIG_DIR = join(process.cwd(), ".envvault");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getDefaultDbPath(): string {
  return join(CONFIG_DIR, "vault.db");
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): EnvVaultConfig {
  // Reading must not touch the filesystem: containers run read-only as non-root.
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as EnvVaultConfig;
  }
  return {};
}

export function saveConfig(config: EnvVaultConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function updateConfig(partial: Partial<EnvVaultConfig>): EnvVaultConfig {
  const next = { ...loadConfig(), ...partial };
  saveConfig(next);
  return next;
}

/**
 * Vault target for local `serve` / SQLite.
 * Precedence: DATABASE_URL → ENVVAULT_DB → config.dbPath → default sqlite path.
 */
export function resolveDbTarget(config = loadConfig()): string {
  const pg = process.env.DATABASE_URL;
  if (pg?.trim()) return pg.trim();

  if (process.env.ENVVAULT_DB) return process.env.ENVVAULT_DB;
  if (config.dbPath) return config.dbPath;
  return getDefaultDbPath();
}
