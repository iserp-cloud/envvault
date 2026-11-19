import { relative } from "node:path";
import { redactSecrets } from "@envvault/shared";

/** Terminal output helpers: color only on a TTY (and never with NO_COLOR), tables, JSON. */

function colorOn(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== "0";
  return Boolean(process.stdout.isTTY);
}

const wrap = (open: number, close: number) => (text: string) =>
  colorOn() ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

export const success = (message: string): void => console.log(`${c.green("✓")} ${message}`);
export const info = (message: string): void => console.log(message);
export const hint = (message: string): void => console.log(c.dim(message));
export const warn = (message: string): void => console.error(`${c.yellow("!")} ${message}`);

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** "2026-11-18 14:03" in local time; the raw value if it isn't a date. */
export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const rel = (path: string): string => relative(process.cwd(), path) || ".";

/**
 * Rows as an aligned table on a terminal; plain tab-separated lines (no header) when piped,
 * so `envvault list | cut -f1` keeps working.
 */
export function printTable(headers: string[], rows: string[][]): void {
  if (!process.stdout.isTTY) {
    for (const row of rows) console.log(row.join("\t"));
    return;
  }
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const widths = headers.map((h, i) =>
    Math.max(visible(h).length, ...rows.map((r) => visible(r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell + " ".repeat(Math.max(0, widths[i]! - visible(cell).length)))
      .join("  ")
      .trimEnd();
  console.log(c.dim(line(headers)));
  for (const row of rows) console.log(line(row));
}

const UNTRUSTED_CERT = /^(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_HAS_EXPIRED)$/;

/** Fingerprint of the certificate trusted for the hub in use, so a mismatch can say what changed. */
let trustedFingerprint: string | undefined;
export function setTrustedFingerprint(fingerprint: string | undefined): void {
  trustedFingerprint = fingerprint;
}

/** The system error code behind a failed `fetch`, which Node reports only as "fetch failed". */
export function networkErrorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } } | null)?.cause;
  // trying IPv4 and IPv6 together reports the failure one level down, as an AggregateError
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  return typeof code === "string" ? code : undefined;
}

/** True when the hub answered with a certificate this computer doesn't trust. */
export function isUntrustedCertError(err: unknown): boolean {
  const code = networkErrorCode(err);
  return code !== undefined && UNTRUSTED_CERT.test(code);
}

function explainNetworkError(err: unknown): string | undefined {
  const code = networkErrorCode(err);
  if (code === undefined) return undefined;
  if (UNTRUSTED_CERT.test(code)) {
    if (trustedFingerprint) {
      return (
        `The hub's certificate is not the one you trusted for it (${trustedFingerprint}). If it was renewed on ` +
        "purpose, run `envvault remote trust`; if not, someone may be impersonating the hub."
      );
    }
    return (
      `The hub's certificate isn't trusted (${code}). Run \`envvault remote set <url>\` to trust a self-made ` +
      "certificate, or `envvault remote set <url> --ca ca.crt` for your own certificate authority " +
      "(or export NODE_EXTRA_CA_CERTS=/path/to/ca.crt)."
    );
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return "The hub's certificate doesn't list the address you used. Re-issue it with that address included.";
  }
  if (code === "ECONNREFUSED") return "Could not connect to the hub (connection refused). Is the address and port right?";
  if (code === "ENOTFOUND") return "Could not find the hub's address. Check the URL.";
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return `Could not reach the hub (${code}). Is it on a network you are connected to?`;
  }
  return undefined;
}

/** Short message for any thrown value, with anything that looks like a credential masked. */
export function messageOf(err: unknown): string {
  const text = explainNetworkError(err) ?? (err instanceof Error ? err.message : String(err));
  return redactSecrets(text);
}
