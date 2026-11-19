import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffEnv } from "../dashboard/src/lib/env-diff.js";

describe("diffEnv (what restoring a version would change)", () => {
  it("reports added, removed and changed keys, sorted", () => {
    const current = { A: "1", B: "2", C: "3" };
    const version = { A: "1", B: "old", D: "4" };
    assert.deepEqual(diffEnv(current, version), [
      { key: "B", kind: "changed", current: "2", version: "old" },
      { key: "C", kind: "removed", current: "3" },
      { key: "D", kind: "added", version: "4" },
    ]);
  });

  it("is empty for identical environments and handles odd key names", () => {
    assert.deepEqual(diffEnv({ A: "x" }, { A: "x" }), []);
    assert.deepEqual(diffEnv({}, { __proto__x: "1", constructor: "2" } as any).map((c) => c.key), ["__proto__x", "constructor"]);
    assert.equal(diffEnv({ constructor: "1" }, {}).length, 1);
  });
});
