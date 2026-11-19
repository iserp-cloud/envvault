import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkPin,
  decodeServiceToken,
  derivePublicKey,
  encodeServiceToken,
  formatFingerprint,
  generateIdentityKeyPair,
  generateRecoveryKey,
  keyFingerprintHex,
  parseRecoveryKey,
  publicKeyFingerprint,
  validateKdf,
} from "@envvault/shared";

describe("client-side crypto helpers", () => {
  it("derives the public key from the private key (detects a swapped key)", async () => {
    const a = await generateIdentityKeyPair();
    const b = await generateIdentityKeyPair();
    assert.equal(await derivePublicKey(a.privateKey), a.publicKey);
    assert.notEqual(await derivePublicKey(a.privateKey), b.publicKey);
  });

  it("pins keys on first use and flags a change", async () => {
    const a = await generateIdentityKeyPair();
    const b = await generateIdentityKeyPair();
    const fpA = await keyFingerprintHex(a.publicKey);
    const fpB = await keyFingerprintHex(b.publicKey);
    const pins: Record<string, string> = {};

    assert.equal(checkPin(pins, "Bob", fpA).status, "new");
    pins["bob"] = fpA;
    assert.equal(checkPin(pins, "BOB", fpA).status, "match", "case-insensitive");
    const changed = checkPin(pins, "bob", fpB);
    assert.equal(changed.status, "changed");
    assert.equal(changed.pinned, fpA);
  });

  it("shows the same fingerprint everywhere", async () => {
    const k = await generateIdentityKeyPair();
    assert.equal(formatFingerprint(await keyFingerprintHex(k.publicKey)), await publicKeyFingerprint(k.publicKey));
  });

  it("recovery keys round-trip, tolerate formatting, and reject garbage", () => {
    const key = generateRecoveryKey();
    assert.match(key, /^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    assert.deepEqual(parseRecoveryKey(key), parseRecoveryKey(key.toLowerCase().replaceAll("-", " ")));
    assert.notEqual(generateRecoveryKey(), key);
    assert.throws(() => parseRecoveryKey("nope"), /Invalid recovery key/);
    assert.throws(() => parseRecoveryKey(key.slice(0, -1) + "U"), /Invalid recovery key/);
  });

  it("service tokens encode/decode and reject malformed input", () => {
    const t = { v: 1 as const, u: "svc-ci", t: "bearer", k: "pk", w: "t_x", r: "https://hub" };
    assert.deepEqual(decodeServiceToken(encodeServiceToken(t)), t);
    assert.throws(() => decodeServiceToken("garbage"), /Not an EnvVault service token/);
    assert.throws(() => decodeServiceToken("evt_" + Buffer.from("{}").toString("base64url")), /Malformed/);
  });

  it("enforces KDF floors", () => {
    assert.ok(validateKdf({ alg: "argon2id", m: 65536, t: 3, p: 1 }));
    assert.ok(validateKdf({ alg: "pbkdf2-sha256", iterations: 600_000 }));
    for (const bad of [
      { alg: "argon2id", m: 4096, t: 3, p: 1 },
      { alg: "argon2id", m: 65536, t: 1, p: 1 },
      { alg: "pbkdf2-sha256", iterations: 100_000 },
      { alg: "md5" },
      null,
    ]) {
      assert.throws(() => validateKdf(bad), /Unsupported key-derivation/);
    }
  });
});
