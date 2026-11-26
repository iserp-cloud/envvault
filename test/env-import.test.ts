import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectAndParseImport, serializeEnvExport, serializeJsonExport } from "../dashboard/src/env-import.js";

describe("dashboard import and export of key groups", () => {
  it("JSON: an object under a group name is that group; top-level text is the default group", () => {
    const r = detectAndParseImport(
      JSON.stringify({ LOG_LEVEL: "info", db: { DATABASE_URL: "u", PORT: 5432 }, payments: { STRIPE_KEY: "s" }, default: { X: "1" } }),
    );
    assert.equal(r.format, "json");
    assert.deepEqual(r.env, { LOG_LEVEL: "info", DATABASE_URL: "u", PORT: "5432", STRIPE_KEY: "s", X: "1" });
    assert.deepEqual(r.groups, { DATABASE_URL: "db", PORT: "db", STRIPE_KEY: "payments" });
    assert.equal(r.hasGroups, true);
  });

  it("JSON: flat files and objects that are not group names import exactly as before", () => {
    const flat = detectAndParseImport('{"A":"1","B":2}');
    assert.deepEqual([flat.env, flat.groups, flat.hasGroups], [{ A: "1", B: "2" }, {}, false]);
    // an upper-case name, or an object holding objects, is still a value holding JSON text
    const legacy = detectAndParseImport('{"FEATURES":{"a":1},"cfg":{"x":{"y":1}}}');
    assert.deepEqual(legacy.env, { FEATURES: '{"a":1}', cfg: '{"x":{"y":1}}' });
    assert.equal(legacy.hasGroups, false);
    assert.deepEqual(detectAndParseImport('[["A","1"]]').env, { A: "1" });
  });

  it(".env: `# @group` lines make groups; other comments do not", () => {
    const r = detectAndParseImport("# Database\nA=1\n# @group db\nB=\"two words\"\n\n# @group default\nC=3\n");
    assert.deepEqual(r.env, { A: "1", B: "two words", C: "3" });
    assert.deepEqual(r.groups, { B: "db" });
    assert.equal(r.hasGroups, true);
    assert.equal(detectAndParseImport("# @groupish\nA=1").hasGroups, false);
    assert.throws(() => detectAndParseImport("A=1\n# @group Not Valid\nB=2"), /Line 2/);
  });

  it("export writes groups back in the same shape, and importing it again gives the same thing", () => {
    const env = { LOG: "info", DB_URL: "u", STRIPE: "s" };
    const groups = { DB_URL: "db", STRIPE: "payments" };
    const dotenv = serializeEnvExport(env, groups);
    assert.equal(dotenv, "LOG=info\n\n# @group db\nDB_URL=u\n\n# @group payments\nSTRIPE=s\n");
    const json = serializeJsonExport(env, groups);
    assert.deepEqual(JSON.parse(json), { LOG: "info", db: { DB_URL: "u" }, payments: { STRIPE: "s" } });
    for (const text of [dotenv, json]) {
      const back = detectAndParseImport(text);
      assert.deepEqual([back.env, back.groups], [env, groups]);
    }
    // no groups: unchanged from the plain files
    assert.equal(serializeEnvExport(env), "DB_URL=u\nLOG=info\nSTRIPE=s\n");
    assert.deepEqual(JSON.parse(serializeJsonExport(env)), env);
  });
});
