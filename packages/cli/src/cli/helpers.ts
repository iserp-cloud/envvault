import { chmodSync, writeFileSync } from "node:fs";
import {
  loadConfig,
  requireSession,
  type EnvVaultConfig,
} from "../config.js";
import { hubListTenants } from "../remote.js";

export async function resolveTenantArg(
  config: EnvVaultConfig,
  tenantArg?: string,
): Promise<string> {
  if (!tenantArg) return requireSession(config).activeTenantId;
  const tenants = await hubListTenants(config);
  const match = tenants.find(
    (t) =>
      t.id === tenantArg ||
      t.slug === tenantArg.toLowerCase() ||
      (tenantArg === "personal" && t.kind === "personal"),
  );
  if (!match) throw new Error(`Tenant not found: ${tenantArg}`);
  return match.id;
}

export { loadConfig };

/**
 * Write decrypted secrets to `path` readable only by you. The `mode` option applies only
 * when a file is created, so an existing world-readable file would keep its permissions —
 * tighten them explicitly.
 */
export function writeSecretFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort (e.g. filesystems without POSIX modes) */
  }
}
