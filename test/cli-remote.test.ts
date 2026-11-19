import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import tls from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
  applyTlsPolicy,
  canTrustCertificates,
  forgetTrustedCert,
  getTrustedCert,
  isLoopback,
  loadConfig,
  normalizeRemote,
  requireRemote,
  requireSession,
  saveTrustedCert,
  updateConfig,
} from "../packages/cli/src/config.js";
import { describeCert, normalizeFingerprint } from "../packages/cli/src/trust.js";

describe("hub URL", () => {
  it("normalises what people type", () => {
    assert.equal(normalizeRemote("https://hub.example.com/"), "https://hub.example.com");
    assert.equal(normalizeRemote("hub.example.com"), "https://hub.example.com");
    assert.equal(normalizeRemote("localhost:8787"), "http://localhost:8787");
    assert.equal(normalizeRemote("127.0.0.1:8787/"), "http://127.0.0.1:8787");
    assert.equal(normalizeRemote("https://example.com/envvault/"), "https://example.com/envvault");
  });

  it("rejects things that aren't a hub address", () => {
    assert.throws(() => normalizeRemote("ftp://hub.example.com"), /https:\/\/ or http:\/\//);
    assert.throws(() => normalizeRemote("http://"), /not a valid hub URL/);
  });

  it("knows which hubs are on this machine", () => {
    assert.ok(isLoopback("http://localhost:8787"));
    assert.ok(isLoopback("http://127.0.0.1:8787"));
    assert.ok(!isLoopback("http://hub.example.com"));
  });
});

describe("a login belongs to its hub", () => {
  let dir: string;
  const saved = { ...process.env };
  const cwd = process.cwd();
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "envvault-remote-"));
    process.chdir(dir); // not the repo, whose own ./.envvault would add a hub
    process.env.ENVVAULT_CONFIG_DIR = dir;
    delete process.env.ENVVAULT_REMOTE;
    delete process.env.ENVVAULT_TOKEN;
  });
  afterEach(() => {
    delete process.env.ENVVAULT_REMOTE;
  });
  after(() => {
    process.chdir(cwd);
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const session = {
    remote: "https://a.example.com",
    token: "tok",
    username: "alice",
    publicKey: "pk",
    personalTenantId: "t1",
    activeTenantId: "t1",
    key: { mode: "password" as const, wrapped: {} as never, kdf: {} as never },
  };

  it("keeps the session on the hub it was made on", () => {
    updateConfig({ remote: "https://a.example.com", session });
    assert.equal(requireSession(loadConfig()).username, "alice");
  });

  it("never offers its token to a different hub", () => {
    updateConfig({ remote: "https://a.example.com", session });
    process.env.ENVVAULT_REMOTE = "https://b.example.com";
    const config = loadConfig();
    assert.equal(config.session, undefined);
    assert.equal(config.otherHub, "https://a.example.com");
    assert.throws(() => requireSession(config), /saved login is for https:\/\/a\.example\.com, not https:\/\/b\.example\.com/);
  });

  it("explains a missing hub", () => {
    updateConfig({ remote: undefined, session: undefined });
    assert.throws(() => requireRemote({}), /remote set <url>/);
  });
});

describe("certificates trusted per hub", () => {
  let dir: string;
  const saved = { ...process.env };
  const cwd = process.cwd();
  const pem = readFileSync(new URL("./fixtures/self-signed.pem", import.meta.url), "utf8");
  const cert = describeCert(pem);
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "envvault-certs-"));
    process.chdir(dir);
    process.env.ENVVAULT_CONFIG_DIR = dir;
    delete process.env.ENVVAULT_INSECURE;
    delete process.env.ENVVAULT_TOKEN;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });
  afterEach(() => {
    applyTlsPolicy({});
    delete process.env.ENVVAULT_INSECURE;
  });
  after(() => {
    process.chdir(cwd);
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const trusts = (p: string) => tls.getCACertificates("default").includes(p);

  it("reads fingerprints in the forms people paste", () => {
    const hex = "AA".repeat(32);
    const colon = Array(32).fill("AA").join(":");
    assert.equal(normalizeFingerprint(colon), colon);
    assert.equal(normalizeFingerprint(`sha256:${colon.toLowerCase()}`), colon);
    assert.equal(normalizeFingerprint(`SHA256=${hex}`), colon);
    assert.equal(normalizeFingerprint("AA:BB"), null);
    assert.equal(normalizeFingerprint("not a fingerprint"), null);
  });

  it("describes a certificate, and sees that it signs itself", () => {
    assert.match(cert.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(cert.selfSigned, true);
    assert.throws(() => describeCert("hello"));
  });

  it("saves, finds and forgets a certificate per hub", () => {
    saveTrustedCert("https://10.0.0.5:30847/", { kind: "pinned", pem, fingerprint: cert.fingerprint });
    assert.equal(getTrustedCert("https://10.0.0.5:30847")?.fingerprint, cert.fingerprint);
    assert.equal(getTrustedCert("https://10.0.0.6:30847"), undefined, "another hub has none");
    forgetTrustedCert("https://10.0.0.5:30847");
    assert.equal(getTrustedCert("https://10.0.0.5:30847"), undefined);
  });

  it("trusts a saved certificate only while talking to its hub", { skip: !canTrustCertificates() }, () => {
    saveTrustedCert("https://10.0.0.5:30847", { kind: "pinned", pem, fingerprint: cert.fingerprint });
    assert.equal(applyTlsPolicy({ remote: "https://10.0.0.5:30847" }).trusted?.fingerprint, cert.fingerprint);
    assert.equal(trusts(pem), true);
    assert.equal(applyTlsPolicy({ remote: "https://other.example.com" }).trusted, undefined);
    assert.equal(trusts(pem), false, "another hub is verified as usual");
    applyTlsPolicy({ remote: "https://10.0.0.5:30847" });
    forgetTrustedCert("https://10.0.0.5:30847");
    applyTlsPolicy({ remote: "https://10.0.0.5:30847" });
    assert.equal(trusts(pem), false, "forgetting takes effect at once");
  });

  it("is off for everything unless asked: --insecure or ENVVAULT_INSECURE", () => {
    assert.equal(applyTlsPolicy({ remote: "https://hub.example.com" }).insecure, false);
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    assert.equal(applyTlsPolicy({ flag: true }).insecure, true);
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
    assert.equal(applyTlsPolicy({}).insecure, false);
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined, "restored once it no longer applies");
    process.env.ENVVAULT_INSECURE = "1";
    assert.equal(applyTlsPolicy({}).insecure, true);
  });

  it("can't be set from a repository's own config files", { skip: !canTrustCertificates() }, () => {
    const hub = "https://evil.example.com";
    mkdirSync(join(dir, ".envvault"), { recursive: true });
    writeFileSync(join(dir, ".envvault", "config.json"), JSON.stringify({ remote: hub, certs: { [hub]: { kind: "ca", pem, fingerprint: "x" } } }));
    writeFileSync(join(dir, "envvault.json"), JSON.stringify({ remote: hub, project: "p", certs: { [hub]: { kind: "ca", pem, fingerprint: "x" } } }));
    assert.equal(applyTlsPolicy({ remote: loadConfig().remote }).trusted, undefined);
    assert.equal(trusts(pem), false);
    rmSync(join(dir, ".envvault"), { recursive: true });
    rmSync(join(dir, "envvault.json"));
  });
});
