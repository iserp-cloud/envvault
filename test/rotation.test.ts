import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitHistory } from "@envvault/shared";

const v = (version: number, size: number) => ({ id: `v${version}`, version, payload: { v: 1, iv: "x", ct: "y".repeat(size) } });

describe("fitHistory", () => {
  it("keeps everything when it fits", () => {
    const { kept, dropped } = fitHistory({ payload: "p" }, [v(1, 100), v(2, 100), v(3, 100)]);
    assert.equal(kept.length, 3);
    assert.equal(dropped.length, 0);
  });

  it("keeps the newest versions and drops the oldest when over budget", () => {
    const versions = [1, 2, 3, 4, 5, 6].map((n) => v(n, 400_000));
    const { kept, dropped } = fitHistory({ payload: "p" }, versions, 1_300_000);
    assert.deepEqual(kept.map((x) => x.version), [6, 5, 4]);
    assert.deepEqual(dropped.map((x) => x.version).sort(), [1, 2, 3]);
  });

  it("never exceeds the budget", () => {
    const base = { payload: "p".repeat(500_000) };
    const { kept } = fitHistory(base, Array.from({ length: 30 }, (_, i) => v(i + 1, 300_000)), 2_000_000);
    const total = JSON.stringify(base).length + kept.reduce((n, x) => n + JSON.stringify(x).length + 1, 0);
    assert.ok(total <= 2_000_000, `${total}`);
  });

  it("sends at most 100 versions, the most the hub accepts", () => {
    const { kept, dropped } = fitHistory({}, Array.from({ length: 130 }, (_, i) => v(i + 1, 10)));
    assert.equal(kept.length, 100);
    assert.equal(dropped.length, 30);
    assert.equal(Math.min(...kept.map((x) => x.version)), 31);
  });

  it("refuses when the request alone is too large, instead of sending one that will be rejected", () => {
    assert.throws(() => fitHistory({ payload: "p".repeat(5_000_000) }, []), /too large to re-key/);
  });
});
