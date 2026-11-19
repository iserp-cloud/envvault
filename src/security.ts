import { createHash } from "node:crypto";

/** Session lifetime in ms (absolute from creation). ENVVAULT_SESSION_DAYS, default 14. */
export function sessionTtlMs(): number {
  const days = Number(process.env.ENVVAULT_SESSION_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 14) * 24 * 60 * 60 * 1000;
}

export type SignupMode = "open" | "invite" | "closed";

/**
 * Who may create accounts once the first (admin) account exists.
 * - open:   anyone
 * - invite: only with an admin-issued single-use invite (default)
 * - closed: nobody
 * Legacy ENVVAULT_ALLOW_SIGNUP=true maps to "open".
 */
export function signupMode(): SignupMode {
  const v = process.env.ENVVAULT_SIGNUP?.trim().toLowerCase();
  if (v === "open" || v === "invite" || v === "closed") return v;
  const legacy = process.env.ENVVAULT_ALLOW_SIGNUP?.trim().toLowerCase();
  if (legacy === "1" || legacy === "true" || legacy === "yes") return "open";
  return "invite";
}

/**
 * CORS allowlist. Always includes local dev origins.
 * Add production URLs via ENVVAULT_CORS_ORIGINS (comma-separated).
 * Same-origin requests are allowed when `requestUrl` is provided.
 */
export function resolveCorsOrigin(
  requestOrigin: string | undefined,
  requestUrl?: string,
): string | null {
  if (!requestOrigin) return null;

  const defaults = [
    "http://127.0.0.1:3847",
    "http://localhost:3847",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ];
  const extra = (process.env.ENVVAULT_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = new Set([...defaults, ...extra]);
  if (allowed.has(requestOrigin)) return requestOrigin;

  if (requestUrl) {
    try {
      if (new URL(requestUrl).origin === requestOrigin) return requestOrigin;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Ciphertext payloads cap at ~2 MB; anything near this is not a legitimate request. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Reject oversized request bodies before they are buffered. Chunked uploads must declare a
 * length. Returns the HTTP status and message to send, or null to let the request through.
 */
export function bodyLimitViolation(
  method: string,
  contentLength: string | null | undefined,
  transferEncoding: string | null | undefined,
): { status: 411 | 413; error: string } | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (contentLength == null || contentLength === "") {
    return transferEncoding ? { status: 411, error: "Content-Length required" } : null;
  }
  const n = Number(contentLength);
  if (!(Number.isInteger(n) && n >= 0 && n <= MAX_BODY_BYTES)) {
    return { status: 413, error: "Request too large" };
  }
  return null;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sessionExpiresAt(from = new Date()): string {
  return new Date(from.getTime() + sessionTtlMs()).toISOString();
}

/** Security headers for HTML / static responses. */
export function securityHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
  // Opt in once TLS terminates in front of the hub (ingress / load balancer).
  const hsts = process.env.ENVVAULT_HSTS?.trim().toLowerCase();
  if (hsts === "1" || hsts === "true" || hsts === "yes") {
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  }
  if (contentType?.includes("text/html")) {
    headers["content-security-policy"] = [
      "default-src 'self'",
      // 'wasm-unsafe-eval' only permits WebAssembly (Argon2id); it does not allow eval() or inline scripts.
      "script-src 'self' 'wasm-unsafe-eval'",
      // Needed: UI libraries inject <style> elements at runtime, which a stricter policy blocks.
      // Scripts stay locked to 'self', so injected styles can't run code.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
  }
  return headers;
}
