/**
 * Zero-knowledge crypto primitives (WebCrypto only: browsers, Node 20+, Workers).
 *
 * Key hierarchy
 *   password ──PBKDF2──▶ master ──HKDF──▶ authKey  (sent to the server as the login proof)
 *                                    └──▶ wrapKey  (never leaves the client; seals the private key)
 *   RSA identity keypair: privateKey sealed with wrapKey and stored server-side.
 *   Environment DEK (AES-256): wrapped per member with RSA-OAEP; env payloads sealed with the DEK.
 *
 * The server only ever sees authKey, public keys, sealed private keys, wrapped DEKs and sealed payloads.
 */

import { argon2id } from "hash-wasm";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Password-stretching parameters (always run client-side, so server CPU limits
 * never apply). Argon2id is memory-hard, which blunts GPU/ASIC guessing; PBKDF2
 * remains supported for runtimes without WASM.
 */
export type KdfParams =
  | { alg: "argon2id"; /** memory in KiB */ m: number; t: number; p: number }
  | { alg: "pbkdf2-sha256"; iterations: number };

export const DEFAULT_KDF: KdfParams = { alg: "argon2id", m: 65_536, t: 3, p: 1 };

/** Bounds a server will accept — floors follow current OWASP guidance. */
export function validateKdf(input: unknown): KdfParams {
  const k = input as Partial<Record<string, unknown>> | null;
  const int = (v: unknown, lo: number, hi: number): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
      throw new Error("Unsupported key-derivation parameters");
    }
    return v;
  };
  if (k?.alg === "argon2id") {
    return { alg: "argon2id", m: int(k.m, 19_456, 1_048_576), t: int(k.t, 2, 12), p: int(k.p, 1, 8) };
  }
  if (k?.alg === "pbkdf2-sha256") {
    return { alg: "pbkdf2-sha256", iterations: int(k.iterations, 600_000, 5_000_000) };
  }
  throw new Error("Unsupported key-derivation parameters");
}

export type SealedBox = {
  v: 1;
  /** base64url AES-GCM nonce (96-bit) */
  iv: string;
  /** base64url ciphertext || 128-bit tag */
  ct: string;
};

function getSubtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("Web Crypto SubtleCrypto is not available");
  return c.subtle;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toB64Url(bytes: ArrayBuffer | Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64Url(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

export function normalizeLoginName(username: string): string {
  return username.trim().toLowerCase();
}

// ── password → keys ────────────────────────────────────────────────────────

/** Slow, salted stretch of the password. Salt is bound to the username. */
export async function deriveMasterKey(
  password: string,
  username: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = getSubtle();
  const pw = password.normalize("NFKC");
  const salt = enc.encode(`envvault/v1/${normalizeLoginName(username)}`);

  if (kdf.alg === "argon2id") {
    const out = await argon2id({
      password: pw,
      salt: new Uint8Array(await subtle.digest("SHA-256", salt)),
      parallelism: kdf.p,
      iterations: kdf.t,
      memorySize: kdf.m,
      hashLength: 32,
      outputType: "binary",
    });
    const copy = new Uint8Array(out.length);
    copy.set(out);
    return copy;
  }

  const base = await subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: kdf.iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export type AccountKeys = {
  /** base64url login proof — the only password-derived value the server receives. */
  authKey: string;
  /** Seals/opens the identity private key. Never sent anywhere. */
  wrapKey: CryptoKey;
};

export async function deriveAccountKeys(
  master: Uint8Array<ArrayBuffer>,
): Promise<AccountKeys> {
  const subtle = getSubtle();
  const ikm = await subtle.importKey("raw", master, "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  const salt = enc.encode("envvault/v1/hkdf");
  const authBits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("auth") },
    ikm,
    256,
  );
  const wrapKey = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("wrap") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { authKey: toB64Url(authBits), wrapKey };
}

export async function deriveFromPassword(
  password: string,
  username: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<AccountKeys> {
  return deriveAccountKeys(await deriveMasterKey(password, username, kdf));
}

// ── AES-GCM sealing ────────────────────────────────────────────────────────

export async function seal(
  plaintext: string,
  key: CryptoKey,
  aad: string,
): Promise<SealedBox> {
  const iv = randomBytes(12);
  const ct = await getSubtle().encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad), tagLength: 128 },
    key,
    enc.encode(plaintext),
  );
  return { v: 1, iv: toB64Url(iv), ct: toB64Url(ct) };
}

export async function open(
  box: SealedBox,
  key: CryptoKey,
  aad: string,
): Promise<string> {
  if (box?.v !== 1) throw new Error("Unsupported ciphertext version");
  const pt = await getSubtle().decrypt(
    {
      name: "AES-GCM",
      iv: fromB64Url(box.iv),
      additionalData: enc.encode(aad),
      tagLength: 128,
    },
    key,
    fromB64Url(box.ct),
  );
  return dec.decode(pt);
}

// ── environment DEKs ───────────────────────────────────────────────────────

/** Random AES-256 key, base64url. */
export function generateDek(): string {
  return toB64Url(randomBytes(32));
}

/** Import a raw base64url AES-256 key for `seal` / `open`. */
export async function importAesKey(keyB64Url: string): Promise<CryptoKey> {
  return importDek(keyB64Url);
}

async function importDek(dek: string): Promise<CryptoKey> {
  return getSubtle().importKey("raw", fromB64Url(dek), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** AAD binds a ciphertext to its location so the server can't swap payloads between envs. */
export function envAad(tenantId: string, project: string, env: string): string {
  return `envvault:env:v1|${tenantId}|${project}|${env}`;
}

export function privateKeyAad(username: string): string {
  return `envvault:privkey:v1|${normalizeLoginName(username)}`;
}

export async function sealEnv(
  env: Record<string, string>,
  dek: string,
  aad: string,
): Promise<SealedBox> {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(env).sort()) sorted[k] = env[k]!;
  return seal(JSON.stringify(sorted), await importDek(dek), aad);
}

export async function openEnv(
  box: SealedBox,
  dek: string,
  aad: string,
): Promise<Record<string, string>> {
  const parsed: unknown = JSON.parse(await open(box, await importDek(dek), aad));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Corrupt environment payload");
  }
  return parsed as Record<string, string>;
}

// ── identity keypair (RSA-OAEP) ────────────────────────────────────────────

/** RSA-OAEP-3072 identity keypair; base64 SPKI / PKCS8. */
export async function generateIdentityKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const subtle = getSubtle();
  const pair = await subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  return {
    publicKey: toB64(await subtle.exportKey("spki", pair.publicKey)),
    privateKey: toB64(await subtle.exportKey("pkcs8", pair.privateKey)),
  };
}

/** Recompute the SPKI public key from a PKCS8 private key (to detect a swapped public key). */
export async function derivePublicKey(privateKeyPkcs8B64: string): Promise<string> {
  const subtle = getSubtle();
  const priv = await subtle.importKey(
    "pkcs8",
    fromB64(privateKeyPkcs8B64),
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"],
  );
  const jwk = await subtle.exportKey("jwk", priv);
  const pub = await subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, ext: true },
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"],
  );
  return toB64(await subtle.exportKey("spki", pub));
}

export async function wrapSecretForPublicKey(
  secret: string,
  publicKeySpkiB64: string,
): Promise<string> {
  const subtle = getSubtle();
  const key = await subtle.importKey(
    "spki",
    fromB64(publicKeySpkiB64),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  return toB64(await subtle.encrypt({ name: "RSA-OAEP" }, key, enc.encode(secret)));
}

export async function unwrapSecretWithPrivateKey(
  wrappedB64: string,
  privateKeyPkcs8B64: string,
): Promise<string> {
  const subtle = getSubtle();
  const key = await subtle.importKey(
    "pkcs8",
    fromB64(privateKeyPkcs8B64),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  return dec.decode(
    await subtle.decrypt({ name: "RSA-OAEP" }, key, fromB64(wrappedB64)),
  );
}

/** Short, human-comparable fingerprint of a public key (verify out-of-band). */
export async function publicKeyFingerprint(publicKeySpkiB64: string): Promise<string> {
  const digest = new Uint8Array(
    await getSubtle().digest("SHA-256", fromB64(publicKeySpkiB64)),
  );
  const hex = [...digest.subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.match(/.{4}/g)!.join(" ");
}

// ── recovery key ───────────────────────────────────────────────────────────
// A second, high-entropy way to unseal the private key, so a forgotten password
// doesn't mean lost data. The server never sees it (only a derived proof).

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 256-bit random key as 13 groups of 4 Crockford-base32 chars: `ABCD-EFGH-…`. */
export function generateRecoveryKey(): string {
  const bytes = randomBytes(32);
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

export function parseRecoveryKey(input: string): Uint8Array<ArrayBuffer> {
  const clean = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (clean.length !== 52) throw new Error("Invalid recovery key");
  const out = new Uint8Array(32);
  let bits = 0;
  let acc = 0;
  let i = 0;
  for (const ch of clean) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new Error("Invalid recovery key");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out[i++] = (acc >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

export type RecoveryKeys = { recoveryAuthKey: string; recoveryWrapKey: CryptoKey };

export async function deriveRecoveryKeys(recoveryKey: string): Promise<RecoveryKeys> {
  const subtle = getSubtle();
  const ikm = await subtle.importKey("raw", parseRecoveryKey(recoveryKey), "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  const salt = enc.encode("envvault/v1/recovery");
  const authBits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("auth") },
    ikm,
    256,
  );
  const recoveryWrapKey = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("wrap") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { recoveryAuthKey: toB64Url(authBits), recoveryWrapKey };
}

export function recoveryAad(username: string): string {
  return `envvault:recovery:v1|${normalizeLoginName(username)}`;
}

export type RecoveryMaterial = {
  /** Show to the user once; never sent to the server. */
  recoveryKey: string;
  recoveryAuthKey: string;
  recoveryWrappedPrivateKey: SealedBox;
};

export async function createRecoveryMaterial(
  username: string,
  privateKey: string,
): Promise<RecoveryMaterial> {
  const recoveryKey = generateRecoveryKey();
  const { recoveryAuthKey, recoveryWrapKey } = await deriveRecoveryKeys(recoveryKey);
  return {
    recoveryKey,
    recoveryAuthKey,
    recoveryWrappedPrivateKey: await seal(privateKey, recoveryWrapKey, recoveryAad(username)),
  };
}

export async function openRecoveredPrivateKey(
  wrapped: SealedBox,
  recoveryWrapKey: CryptoKey,
  username: string,
): Promise<string> {
  return open(wrapped, recoveryWrapKey, recoveryAad(username));
}

// ── public-key pinning (trust on first use) ────────────────────────────────

/** Full SHA-256 of the SPKI, hex. Used for pinning; show `formatFingerprint` to humans. */
export async function keyFingerprintHex(publicKeySpkiB64: string): Promise<string> {
  const digest = new Uint8Array(await getSubtle().digest("SHA-256", fromB64(publicKeySpkiB64)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function formatFingerprint(hex: string): string {
  return hex.slice(0, 32).match(/.{4}/g)!.join(" ");
}

export type PinCheck = {
  status: "new" | "match" | "changed";
  fingerprint: string;
  pinned?: string;
};

export function checkPin(
  pins: Record<string, string>,
  username: string,
  fingerprint: string,
): PinCheck {
  const pinned = pins[normalizeLoginName(username)];
  if (!pinned) return { status: "new", fingerprint };
  return { status: pinned === fingerprint ? "match" : "changed", fingerprint, pinned };
}

// ── service tokens (machine credentials) ───────────────────────────────────

export type ServiceToken = {
  v: 1;
  /** service account username */
  u: string;
  /** bearer session token */
  t: string;
  /** PKCS8 private key (base64) — the server never sees this */
  k: string;
  /** workspace (tenant) the account belongs to */
  w: string;
  /** hub origin */
  r: string;
};

const TOKEN_PREFIX = "evt_";

export function encodeServiceToken(token: ServiceToken): string {
  return TOKEN_PREFIX + toB64Url(enc.encode(JSON.stringify(token)));
}

export function decodeServiceToken(raw: string): ServiceToken {
  const s = raw.trim();
  if (!s.startsWith(TOKEN_PREFIX)) throw new Error("Not an EnvVault service token");
  const parsed = JSON.parse(dec.decode(fromB64Url(s.slice(TOKEN_PREFIX.length)))) as ServiceToken;
  if (parsed?.v !== 1 || !parsed.u || !parsed.t || !parsed.k || !parsed.w || !parsed.r) {
    throw new Error("Malformed service token");
  }
  return parsed;
}

// ── account material (signup / password change) ────────────────────────────

export type NewAccountMaterial = {
  authKey: string;
  kdf: KdfParams;
  publicKey: string;
  privateKey: string;
  wrappedPrivateKey: SealedBox;
  recovery: RecoveryMaterial;
};

/** Everything a client sends at signup; the password itself never leaves the device. */
export async function createAccountMaterial(
  username: string,
  password: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<NewAccountMaterial> {
  const { authKey, wrapKey } = await deriveFromPassword(password, username, kdf);
  const { publicKey, privateKey } = await generateIdentityKeyPair();
  return {
    authKey,
    kdf,
    publicKey,
    privateKey,
    wrappedPrivateKey: await seal(privateKey, wrapKey, privateKeyAad(username)),
    recovery: await createRecoveryMaterial(username, privateKey),
  };
}

export async function openPrivateKey(
  wrapped: SealedBox,
  wrapKey: CryptoKey,
  username: string,
): Promise<string> {
  return open(wrapped, wrapKey, privateKeyAad(username));
}

export function personalTenantId(username: string): string {
  return `p_${normalizeLoginName(username)}`;
}
