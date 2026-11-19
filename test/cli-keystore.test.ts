import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createAccountMaterial } from "@envvault/shared";
import {
  getGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  type CliSession,
} from "../packages/cli/src/config.js";
import {
  __setKeyringForTests,
  forgetDeviceKey,
  migrateLegacySessionKey,
  persistSession,
  protectPrivateKey,
  unlockPrivateKey,
  type Ring,
} from "../packages/cli/src/keystore.js";

const REMOTE = "https://hub.test";
const PASSWORD = "correct horse battery staple";

function fakeRing(): Ring & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(a) { return store.get(a) ?? null; },
    async set(a, s) { store.set(a, s); },
    async delete(a) { store.delete(a); },
  };
}

let dir: string;
let privateKey: string;
let sessionBase: CliSession;

const onDisk = () => readFileSync(getGlobalConfigPath(), "utf8");

describe("CLI private-key storage", () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "envvault-cli-"));
    process.env.ENVVAULT_CONFIG_DIR = dir;
    delete process.env.ENVVAULT_PASSWORD;
    const m = await createAccountMaterial("alice", PASSWORD);
    privateKey = m.privateKey;
    sessionBase = {
      token: "tok", username: "alice", publicKey: m.publicKey,
      personalTenantId: "p_alice", activeTenantId: "p_alice",
      privateKey: m.privateKey,
      passwordKey: { wrapped: m.wrappedPrivateKey, kdf: m.kdf },
    };
  });
  beforeEach(() => {
    rmSync(join(dir, "config.json"), { force: true });
    delete process.env.ENVVAULT_PASSWORD;
    __setKeyringForTests(undefined);
  });
  after(() => {
    __setKeyringForTests(undefined);
    delete process.env.ENVVAULT_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("keychain mode: key is sealed on disk and unlocked via the keychain", async () => {
    const ring = fakeRing();
    __setKeyringForTests(ring);
    assert.equal(await persistSession(REMOTE, { ...sessionBase }), "keychain");

    const text = onDisk();
    assert.ok(!text.includes(privateKey), "plaintext private key must not be in the config file");
    assert.ok(!text.includes('"privateKey"'), "no privateKey field persisted");
    assert.equal(ring.store.size, 1, "device key stored in the keychain");
    assert.ok(![...ring.store.values()].some((v) => text.includes(v)), "device key is not on disk");

    // A brand-new process only has what's in the file.
    const loaded = loadGlobalConfig().session!;
    assert.equal(loaded.privateKey, undefined);
    assert.equal(loaded.key?.mode, "keychain");
    __setKeyringForTests(ring); // reset the in-process cache
    assert.equal(await unlockPrivateKey(loaded, REMOTE), privateKey);
  });

  it("the config file alone is useless without the keychain entry", async () => {
    const ring = fakeRing();
    __setKeyringForTests(ring);
    await persistSession(REMOTE, { ...sessionBase });
    const loaded = loadGlobalConfig().session!;

    await forgetDeviceKey(REMOTE, "alice"); // logout
    assert.equal(ring.store.size, 0);
    __setKeyringForTests(ring);
    await assert.rejects(unlockPrivateKey(loaded, REMOTE), /keychain|login/i);
  });

  it("password mode (no keychain): only the password-sealed copy is stored", async () => {
    __setKeyringForTests(null);
    assert.equal(await persistSession(REMOTE, { ...sessionBase }), "password");
    assert.ok(!onDisk().includes(privateKey));
    const loaded = loadGlobalConfig().session!;
    assert.equal(loaded.key?.mode, "password");

    __setKeyringForTests(null);
    await assert.rejects(unlockPrivateKey(loaded, REMOTE), /no terminal|ENVVAULT_PASSWORD/i);

    process.env.ENVVAULT_PASSWORD = "wrong password here";
    __setKeyringForTests(null);
    await assert.rejects(unlockPrivateKey(loaded, REMOTE), /Wrong password/);

    process.env.ENVVAULT_PASSWORD = PASSWORD;
    __setKeyringForTests(null);
    assert.equal(await unlockPrivateKey(loaded, REMOTE), privateKey);
  });

  it("refuses to store anything when it can't protect the key", async () => {
    __setKeyringForTests(null);
    await assert.rejects(
      protectPrivateKey({ remote: REMOTE, username: "alice", privateKey }),
      /No OS keychain/,
    );
  });

  it("never writes a decrypted key to disk, whatever the caller passes", () => {
    saveGlobalConfig({ remote: REMOTE, session: { ...sessionBase } });
    const text = onDisk();
    assert.ok(!text.includes(privateKey));
    assert.ok(!text.includes("passwordKey"));
    assert.equal(JSON.parse(text).session.token, "tok");
  });

  it("migrates a legacy plaintext key into protected storage", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      remote: REMOTE,
      session: { token: "tok", username: "alice", publicKey: "pk", personalTenantId: "p_alice", activeTenantId: "p_alice", privateKey },
    }));
    assert.ok(onDisk().includes(privateKey), "starts out as plaintext");

    const ring = fakeRing();
    __setKeyringForTests(ring);
    const g = loadGlobalConfig();
    assert.equal(await migrateLegacySessionKey(g.remote, g.session!), "migrated");
    assert.ok(!onDisk().includes(privateKey), "plaintext removed from the file");
    __setKeyringForTests(ring);
    assert.equal(await unlockPrivateKey(loadGlobalConfig().session!, REMOTE), privateKey);
  });

  it("warns (and leaves the file) when there is nowhere safe to move a legacy key", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      remote: REMOTE,
      session: { token: "tok", username: "alice", publicKey: "pk", personalTenantId: "p", activeTenantId: "p", privateKey },
    }));
    __setKeyringForTests(null);
    const g = loadGlobalConfig();
    assert.equal(await migrateLegacySessionKey(g.remote, g.session!), "still-plaintext");
  });
});
