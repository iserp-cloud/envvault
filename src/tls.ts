import { readFileSync } from "node:fs";

export type TlsFiles = { cert: string; key: string };

/**
 * Optional built-in https, for a hub reached directly by IP and port with no proxy in front.
 * Browsers run EnvVault's encryption only on https (or localhost) pages. Set both
 * `ENVVAULT_TLS_CERT` and `ENVVAULT_TLS_KEY` to PEM file paths, or neither.
 */
export function tlsFromEnv(env: NodeJS.ProcessEnv = process.env): TlsFiles | null {
  const certPath = env.ENVVAULT_TLS_CERT?.trim();
  const keyPath = env.ENVVAULT_TLS_KEY?.trim();
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error("Set both ENVVAULT_TLS_CERT and ENVVAULT_TLS_KEY (paths to the PEM files), or neither.");
  }
  try {
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new Error(`Cannot read the TLS certificate or key (${code ?? "error"}): check ENVVAULT_TLS_CERT / ENVVAULT_TLS_KEY.`);
  }
}
