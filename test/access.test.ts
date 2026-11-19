import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { covers, describeAccess, effectiveCaps, hasCap, normalizeGrant, parseCaps } from "@envvault/shared";

describe("access permissions", () => {
  it("parses stored caps, dropping unknown ones, in a fixed order", () => {
    assert.deepEqual(parseCaps("rotate, nonsense,delete"), ["delete", "rotate"]);
    assert.deepEqual(parseCaps(""), []);
  });

  it("gives a manager every permission and a writer only what's listed", () => {
    assert.deepEqual(effectiveCaps("manage", ""), ["delete", "share", "rotate"]);
    assert.deepEqual(effectiveCaps("write", "share"), ["share"]);
    assert.equal(hasCap("write", "", "delete"), false);
    assert.equal(hasCap("read", "delete", "delete"), true);
  });

  it("stores write plus every permission as a manager", () => {
    assert.deepEqual(normalizeGrant("write", ["delete", "share", "rotate"]), { level: "manage", caps: [] });
    assert.deepEqual(normalizeGrant("manage", ["delete"]), { level: "manage", caps: [] });
    assert.deepEqual(normalizeGrant("read", ["share", "bogus"]), { level: "read", caps: ["share"] });
  });

  it("covers only grants that are no more than the holder's", () => {
    const sharer = { level: "write" as const, caps: "share" };
    assert.equal(covers(sharer, { level: "read", caps: "" }), true);
    assert.equal(covers(sharer, { level: "write", caps: "share" }), true);
    assert.equal(covers(sharer, { level: "write", caps: "delete" }), false);
    assert.equal(covers(sharer, { level: "manage", caps: "" }), false);
    assert.equal(covers({ level: "manage", caps: "" }, { level: "write", caps: "delete,rotate" }), true);
  });

  it("describes access for badges", () => {
    assert.equal(describeAccess("manage", ""), "manager");
    assert.equal(describeAccess("write", "delete,share"), "write + delete, share");
    assert.equal(describeAccess("read", ""), "read");
  });
});
