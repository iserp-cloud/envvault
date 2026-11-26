import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeServiceToken, derivePublicKey, openEnv, unwrapSecretWithPrivateKey } from "@envvault/shared";

/** The same file is read by the Go operator's tests; if this breaks, the format changed. */
const v = JSON.parse(readFileSync(new URL("./vectors/zk-6.json", import.meta.url), "utf8"));

describe("protocol vectors (zk-6)", () => {
  it("decodes the service token", () => {
    const t = decodeServiceToken(v.serviceToken);
    assert.deepEqual({ v: t.v, u: t.u, t: t.t, w: t.w, r: t.r }, v.tokenFields);
    assert.equal(t.k.length > 0, true);
  });

  it("token private key matches the public key", async () => {
    assert.equal(await derivePublicKey(decodeServiceToken(v.serviceToken).k), v.publicKey);
  });

  it("unwraps the DEK and opens the environment", async () => {
    const t = decodeServiceToken(v.serviceToken);
    const e = v.environment;
    const dek = await unwrapSecretWithPrivateKey(e.wrappedEnvDek, t.k);
    assert.deepEqual(await openEnv(e.payload, dek, e.aad), e.expected);
  });

  it("rejects a wrong location, a bad version and tampering", async () => {
    const t = decodeServiceToken(v.serviceToken);
    const e = v.environment;
    const dek = await unwrapSecretWithPrivateKey(e.wrappedEnvDek, t.k);
    await assert.rejects(openEnv(e.payload, dek, v.mustFail.wrongAad));
    await assert.rejects(openEnv(v.mustFail.badVersion, dek, e.aad));
    await assert.rejects(openEnv(v.mustFail.tamperedCiphertext, dek, e.aad));
  });
});
