import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { tlsFromEnv } from "../src/tls.js";

describe("tlsFromEnv", () => {
  const dir = mkdtempSync(join(tmpdir(), "envvault-tls-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const cert = join(dir, "tls.crt");
  const key = join(dir, "tls.key");
  writeFileSync(cert, "CERT");
  writeFileSync(key, "KEY");

  it("is off by default", () => {
    assert.equal(tlsFromEnv({}), null);
  });

  it("reads the certificate and key from the given paths", () => {
    assert.deepEqual(tlsFromEnv({ ENVVAULT_TLS_CERT: cert, ENVVAULT_TLS_KEY: key }), { cert: "CERT", key: "KEY" });
  });

  it("refuses half a configuration and unreadable files", () => {
    assert.throws(() => tlsFromEnv({ ENVVAULT_TLS_CERT: cert }), /both ENVVAULT_TLS_CERT and ENVVAULT_TLS_KEY/);
    assert.throws(() => tlsFromEnv({ ENVVAULT_TLS_KEY: key }), /both/);
    assert.throws(() => tlsFromEnv({ ENVVAULT_TLS_CERT: "/nope.crt", ENVVAULT_TLS_KEY: "/nope.key" }), /Cannot read the TLS/);
  });
});
