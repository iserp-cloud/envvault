import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { httpsLocation, redirectingFront, tlsFromEnv } from "../src/tls.js";

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

describe("redirectingFront", () => {
  const dir = mkdtempSync(join(tmpdir(), "envvault-front-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });

  const start = async () => {
    const https = createHttpsServer({ cert: readFileSync(join(dir, "c.pem")), key: readFileSync(join(dir, "k.pem")) }, (_req, res) => res.end("secure"));
    const front = redirectingFront(https, "fallback:1");
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    return { front, port: (front.address() as { port: number }).port };
  };

  it("keeps serving https and redirects plain http to the same address", { skip: made.status !== 0 }, async () => {
    const { front, port } = await start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/app?x=1`, { redirect: "manual" });
      assert.equal(res.status, 308);
      assert.equal(res.headers.get("location"), `https://127.0.0.1:${port}/app?x=1`);

      const tlsReply = await new Promise<string>((resolve, reject) => {
        const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
          socket.write("GET / HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n");
        });
        let out = "";
        socket.on("data", (d) => (out += d));
        socket.on("end", () => resolve(out));
        socket.on("error", reject);
      });
      assert.match(tlsReply, /secure$/);
    } finally {
      front.close();
    }
  });

  it("never redirects to a made-up host or a protocol-relative path", () => {
    assert.equal(httpsLocation("a.example:8443", "f:1", "/x"), "https://a.example:8443/x");
    assert.equal(httpsLocation("evil.com/x@y", "f:1", "//evil.com"), "https://f:1/");
    assert.equal(httpsLocation(undefined, "f:1", undefined), "https://f:1/");
  });
});
