import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GROUP,
  hasGroupMarkers,
  parseEnvGroups,
  serializeEnv,
  serializeEnvGroups,
  cleanLabels,
  envAad,
  generateDek,
  groupCounts,
  keysInGroup,
  knownGroups,
  open,
  normalizeGroup,
  openEnv,
  openEnvData,
  pruneGroups,
  seal,
  sealEnv,
  sealEnvData,
  validateGroupName,
  importAesKey,
} from "@envvault/shared";

const aad = envAad("t1", "shop", "prod");

describe("key groups", () => {
  it("names: lower-case slugs; `default` and empty mean no group", () => {
    assert.equal(validateGroupName("db"), null);
    assert.equal(validateGroupName("api-keys"), null);
    for (const bad of ["", "  ", "DB", "-x", "a b", "a_b", "x".repeat(41)]) assert.notEqual(validateGroupName(bad), null, bad);
    assert.equal(normalizeGroup(" DB "), "db");
    assert.equal(normalizeGroup("default"), "");
    assert.equal(normalizeGroup(undefined), "");
  });

  it("pruneGroups drops groups of deleted keys, empty groups and the default group", () => {
    assert.deepEqual(pruneGroups({ A: "1", B: "2" }, { A: "db", B: "default", C: "gone", D: "" }), { A: "db" });
  });

  it("an environment with no groups is sealed exactly as before: a plain, sorted JSON object", async () => {
    const dek = generateDek();
    const box = await sealEnvData({ vars: { B: "2", A: "1" }, groups: {} }, dek, aad);
    const plain = await (async () => {
      // open with the low-level primitives to see the raw plaintext
      const { open } = await import("@envvault/shared");
      return open(box, await importAesKey(dek), aad);
    })();
    assert.equal(plain, '{"A":"1","B":"2"}');
    assert.deepEqual(await openEnv(box, dek, aad), { A: "1", B: "2" });
    assert.deepEqual(await openEnvData(box, dek, aad), { vars: { A: "1", B: "2" }, groups: {}, labels: [] });
  });

  it("groups round-trip, and the plain openEnv refuses a grouped environment instead of dropping the groups", async () => {
    const dek = generateDek();
    const data = { vars: { DB_URL: "u", LOG: "info", TOKEN: "t" }, groups: { DB_URL: "db", LOG: "app" }, labels: [] };
    const box = await sealEnvData(data, dek, aad);
    assert.deepEqual(await openEnvData(box, dek, aad), data);
    await assert.rejects(openEnv(box, dek, aad), /key groups/);
  });

  it("a plain environment may have keys called v, vars or groups", async () => {
    const dek = generateDek();
    const vars = { v: "2", vars: "x", groups: "y" };
    assert.deepEqual(await openEnvData(await sealEnv(vars, dek, aad), dek, aad), { vars, groups: {}, labels: [] });
  });

  it("refuses payloads that are not what a client wrote", async () => {
    const dek = generateDek();
    const key = await importAesKey(dek);
    const open = async (plain: unknown) => openEnvData(await seal(JSON.stringify(plain), key, aad), dek, aad);
    await assert.rejects(open({ v: 3, vars: {}, groups: {} }), /newer EnvVault/);
    await assert.rejects(open({ v: 2, vars: { A: 1 }, groups: {} }), /not text/);
    await assert.rejects(open({ v: 2, vars: { A: "1" }, groups: { B: "db" } }), /groups/); // a group for a key that is not there
    await assert.rejects(open({ v: 2, vars: { A: "1" }, groups: { A: "default" } }), /groups/);
    await assert.rejects(open({ v: 2, vars: { A: "1" }, groups: { A: "Bad Name" } }), /groups/);
    await assert.rejects(open({ A: 1 }), /not text/);
    await assert.rejects(open([]), /Corrupt/);
  });

  it("keysInGroup and groupCounts treat keys with no group as `default`", () => {
    const vars = { A: "1", B: "2", C: "3" };
    const groups = { B: "db" };
    assert.deepEqual(keysInGroup(vars, groups, "default"), { A: "1", C: "3" });
    assert.deepEqual(keysInGroup(vars, groups, "db"), { B: "2" });
    assert.deepEqual(keysInGroup(vars, groups, "nope"), {});
    assert.deepEqual(groupCounts(vars, groups), [{ group: DEFAULT_GROUP, keys: 2 }, { group: "db", keys: 1 }]);
  });

  it("keeps a registry of group names, even for names no key uses, and stays plain without one", async () => {
    const dek = generateDek();
    const aad = envAad("t", "p", "e");
    const vars = { A: "1", B: "2" };
    const box = await sealEnvData({ vars, groups: {}, labels: ["queue", "db", "DB", " db ", "default", "Bad Name"] }, dek, aad);
    const data = await openEnvData(box, dek, aad);
    assert.deepEqual(data.labels, ["db", "queue"]); // cleaned: lowercased, unique, sorted, invalid and `default` dropped
    assert.deepEqual(data.groups, {});
    assert.deepEqual(JSON.parse(await open(box, await importAesKey(dek), aad)), { v: 2, vars, groups: {}, labels: ["db", "queue"] });
    // a registry alone is enough to refuse it for a client that cannot carry it
    await assert.rejects(openEnv(box, dek, aad), /groups/);
    // no groups and no labels: byte-for-byte the plain object, as before
    const plain = await sealEnvData({ vars, groups: {}, labels: [] }, dek, aad);
    assert.equal(await open(plain, await importAesKey(dek), aad), '{"A":"1","B":"2"}');
    assert.deepEqual(await openEnv(plain, dek, aad), vars);
  });

  it("knownGroups offers the registry plus the groups in use, never default", () => {
    assert.deepEqual(knownGroups(["queue"], { A: "db", B: "db", C: "api" }), ["api", "db", "queue"]);
    assert.deepEqual(knownGroups([], {}), []);
    assert.deepEqual(cleanLabels(["b", "a", "b", "default", "NOPE_X"]), ["a", "b"]);
  });
});

describe("# @group markers in .env text", () => {
  it("keys above the first marker are default; a marker applies until the next; `default` ends a section", () => {
    const text = "A=1\n\n# @group db\nB=2\nC=3\n# a plain comment\n# @group default\nD=4\n# @group queue\nE=5\n";
    assert.deepEqual(parseEnvGroups(text), {
      vars: { A: "1", B: "2", C: "3", D: "4", E: "5" },
      groups: { B: "db", C: "db", E: "queue" },
    });
  });

  it("plain comments, blank lines and commented-out keys never make a group", () => {
    const text = "# Database\nA=1\n\n\n# @groupish\n# (db)\n# OLD=1\nB=2\n";
    assert.deepEqual(parseEnvGroups(text), { vars: { A: "1", B: "2" }, groups: {} });
    assert.equal(hasGroupMarkers(text), false);
    assert.equal(hasGroupMarkers("# @group db\nA=1"), true);
  });

  it("a bad marker is an error that names the line", () => {
    assert.throws(() => parseEnvGroups("A=1\n# @group Bad Name\nB=2"), /Line 2/);
    assert.throws(() => parseEnvGroups("# @group\nA=1"), /Line 1.*needs a group name/);
    assert.throws(() => parseEnvGroups("# @group a_b\nA=1"), /Line 1/);
  });

  it("serialises the default keys first, then a section per group, and round-trips", () => {
    const vars = { LOG: "info", DB_URL: "u", DB_PASS: "p", STRIPE: "s" };
    const groups = { DB_URL: "db", DB_PASS: "db", STRIPE: "payments" };
    const text = serializeEnvGroups(vars, groups);
    assert.equal(text, "LOG=info\n\n# @group db\nDB_PASS=p\nDB_URL=u\n\n# @group payments\nSTRIPE=s\n");
    assert.deepEqual(parseEnvGroups(text), { vars, groups });
    assert.equal(serializeEnvGroups(vars, {}), serializeEnv(vars)); // no groups: exactly the plain file
  });

  it("a group with no keys is not written", () => {
    assert.equal(serializeEnvGroups({ A: "1" }, { B: "db" }), "A=1\n");
  });
});
