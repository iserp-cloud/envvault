import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The server never sees passwords. Clients derive a 256-bit `authKey` with a slow
 * KDF and send only that. We store a salted, optionally peppered hash of it, so a
 * database dump alone cannot be used to log in (and with ENVVAULT_PEPPER set, cannot
 * even be used to test password guesses offline).
 */

export const AUTH_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export function pepperConfigured(): boolean {
  return Boolean(process.env.ENVVAULT_PEPPER?.trim());
}

/**
 * Without a pepper, stored login-proof hashes and audit MACs use a public constant:
 * a database dump could then be used to test password guesses offline, and audit rows
 * could be forged. `strict` (production / Workers) refuses to run that way.
 */
export function pepperPolicy(strict: boolean): "ok" | "warn" | "refuse" {
  if (pepperConfigured()) return "ok";
  const allow = process.env.ENVVAULT_ALLOW_NO_PEPPER?.trim().toLowerCase();
  if (strict && allow !== "true" && allow !== "1") return "refuse";
  return "warn";
}

/** Stable pseudo-random index in [0, n) derived from a value and the pepper. */
export function pseudoIndex(value: string, n: number): number {
  const d = createHmac("sha256", pepper()).update("pseudo|").update(value).digest();
  return d.readUInt32BE(0) % Math.max(1, n);
}

function pepper(): Buffer {
  const p = process.env.ENVVAULT_PEPPER?.trim();
  return p ? Buffer.from(p, "utf8") : Buffer.from("envvault/v1/auth", "utf8");
}

export function newAuthSalt(): string {
  return randomBytes(16).toString("base64url");
}

/** MAC for tamper-evident audit rows. */
export function auditMac(fields: string[]): string {
  return createHmac("sha256", pepper()).update("audit|").update(fields.join("\u001f")).digest("base64url");
}

/** `domain` keeps login proofs and recovery proofs from ever being interchangeable. */
export function hashAuthKey(authKey: string, salt: string, domain: "auth" | "recovery" = "auth"): string {
  return createHmac("sha256", pepper())
    .update(domain)
    .update("|")
    .update(salt)
    .update("|")
    .update(authKey)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifyAuthKey(
  authKey: string,
  salt: string,
  expectedHash: string,
  domain: "auth" | "recovery" = "auth",
): boolean {
  return safeEqual(hashAuthKey(authKey, salt, domain), expectedHash);
}

/** Used for unknown usernames so response time doesn't reveal which accounts exist. */
export const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA";
export const DUMMY_HASH = hashAuthKey("x".repeat(43), DUMMY_SALT);

export function constantTimeEquals(a: string, b: string): boolean {
  return safeEqual(a, b);
}

export function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
