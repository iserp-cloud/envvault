import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeServiceToken, derivePublicKey, keysInGroup, openEnv, openEnvData, unwrapSecretWithPrivateKey } from "@envvault/shared";

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

  it("opens the environment with key groups and splits it by group", async () => {
    const t = decodeServiceToken(v.serviceToken);
    const e = v.environment;
    const g = v.groupedEnvironment;
    const dek = await unwrapSecretWithPrivateKey(e.wrappedEnvDek, t.k);
    const data = await openEnvData(g.payload, dek, e.aad);
    assert.deepEqual(data, g.expected);
    for (const [group, keys] of Object.entries(g.byGroup)) assert.deepEqual(keysInGroup(data.vars, data.groups, group), keys, group);
    // a client that cannot handle groups must refuse the environment, not drop them
    await assert.rejects(openEnv(g.payload, dek, e.aad), /groups/);
  });

  it("opens the environment with a registry of group names, and a plain reader refuses it", async () => {
    const t = decodeServiceToken(v.serviceToken);
    const e = v.environment;
    const dek = await unwrapSecretWithPrivateKey(e.wrappedEnvDek, t.k);
    const data = await openEnvData(v.labelledEnvironment.payload, dek, e.aad);
    assert.deepEqual(data, v.labelledEnvironment.expected);
    assert.ok(data.labels.includes("queue") && !Object.values(data.groups).includes("queue"), "a registered name needs no key");
    await assert.rejects(openEnv(v.labelledEnvironment.payload, dek, e.aad), /groups/);
  });

  it("rejects grouped payloads that are not valid environments", async () => {
    const t = decodeServiceToken(v.serviceToken);
    const e = v.environment;
    const dek = await unwrapSecretWithPrivateKey(e.wrappedEnvDek, t.k);
    for (const [why, box] of Object.entries(v.groupedEnvironment.mustFail)) {
      await assert.rejects(openEnvData(box as never, dek, e.aad), `${why} was accepted`);
    }
  });
});
