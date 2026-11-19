import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeDbTarget, describeError, encodeServiceToken, redactSecrets } from "@envvault/shared";

describe("redactSecrets", () => {
  it("masks database passwords, even ones containing @", () => {
    assert.equal(redactSecrets("connect postgresql://testuser:pa@ss@192.0.2.10:5432/db failed"),
      "connect postgresql://testuser:***@192.0.2.10:5432/db failed");
    assert.ok(!redactSecrets("postgres://u:s3cret!@h/db").includes("s3cret"));
  });

  it("masks bearer tokens and service tokens", () => {
    assert.equal(redactSecrets("Authorization: Bearer abc.def-123"), "Authorization: Bearer ***");
    const token = encodeServiceToken({ v: 1, u: "ci", t: "sessiontoken", k: "PRIVATEKEYMATERIAL", w: "w1", r: "https://hub" });
    const out = redactSecrets(`using ${token} for the run`);
    assert.ok(!out.includes(token.slice(8)));
    assert.match(out, /evt_\*\*\*/);
  });

  it("masks values of secret-named fields in text and JSON", () => {
    for (const text of [
      "password=hunter2xx", 'PEPPER: "abcdef123456"', '{"token":"abc123def"}', "ENVVAULT_TOKEN=evt_abcdefgh12345", "privateKey = MIIEvQ",
    ]) {
      const out = redactSecrets(text);
      assert.match(out, /\*\*\*/, text);
      assert.ok(!/hunter2xx|abcdef123456|abc123def|abcdefgh12345|MIIEvQ/.test(out), `${text} -> ${out}`);
    }
  });

  it("leaves ordinary text alone", () => {
    for (const text of ["No access to app/default.", "Environment list failed: ECONNREFUSED 127.0.0.1:8787", "pulled 12 vars"]) {
      assert.equal(redactSecrets(text), text);
    }
  });
});

describe("describeDbTarget", () => {
  it("shows user, host and database but never the password or other parameters", () => {
    assert.equal(describeDbTarget("postgresql://testuser:pa@ss@192.0.2.10:5432/envvault?sslmode=disable&password=x&options=--secret"),
      "postgresql://testuser:***@192.0.2.10:5432/envvault?sslmode=disable");
    assert.equal(describeDbTarget("/data/vault.db"), "/data/vault.db");
    assert.ok(!describeDbTarget("postgresql://u:p%40ss@h/db").includes("ss"));
  });
});

describe("describeError", () => {
  it("keeps name, code and message but not attached data", () => {
    const err = Object.assign(new Error("duplicate key"), {
      code: "23505",
      detail: "Key (username)=(alice) already exists",
      data: { password: "hunter2" },
      cause: new Error("secret cause"),
    });
    const line = describeError(err);
    assert.equal(line, "Error [23505]: duplicate key");
    assert.ok(!/alice|hunter2|secret cause/.test(line));
  });

  it("redacts the message itself and tolerates non-errors", () => {
    assert.ok(!describeError(new Error("bad url postgresql://u:topsecret@h/db")).includes("topsecret"));
    assert.equal(describeError({ password: "x" }), "non-error thrown");
  });
});
