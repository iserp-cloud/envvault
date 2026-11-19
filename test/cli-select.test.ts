import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initialState, parseKeys, step, visibleIndexes, type Key, type SelectState } from "../packages/cli/src/cli/select.js";

const labels = ["backend-iserp", "backend-cli", "frontend-home", "module-hr"];
const run = (keys: Key[], from: SelectState = initialState()) =>
  keys.reduce((state, key) => step(state, key, labels, 10), from);
const chosen = (s: SelectState) => [...s.chosen].sort();

describe("interactive select", () => {
  it("moves with wrap-around and toggles with space", () => {
    const s = run([{ name: "space" }, { name: "down" }, { name: "down" }, { name: "space" }]);
    assert.deepEqual(chosen(s), [0, 2]);
    assert.equal(run([{ name: "up" }]).cursor, 3); // wraps to the end
    assert.deepEqual(chosen(run([{ name: "space" }, { name: "space" }])), []);
  });

  it("filters by typing, and selects what is shown", () => {
    const s = run([{ name: "char", char: "b" }, { name: "char", char: "a" }, { name: "space" }]);
    assert.deepEqual(visibleIndexes(labels, s.filter), [0, 1]);
    assert.deepEqual(chosen(s), [0]); // cursor reset to the first match
    const all = run([{ name: "char", char: "b" }, { name: "all" }]);
    assert.deepEqual(chosen(all), [0, 1]);
    assert.deepEqual(chosen(run([{ name: "all" }, { name: "all" }])), []); // second press clears
  });

  it("keeps picks made before the filter changed", () => {
    const s = run([{ name: "space" }, { name: "char", char: "h" }, { name: "char", char: "r" }, { name: "space" }, { name: "backspace" }, { name: "backspace" }]);
    assert.deepEqual(chosen(s), [0, 3]);
    assert.equal(s.filter, "");
  });

  it("submits and cancels", () => {
    assert.equal(run([{ name: "enter" }]).done, "submit");
    assert.equal(run([{ name: "cancel" }]).done, "cancel");
  });

  it("decodes terminal input", () => {
    assert.deepEqual(parseKeys("\u001b[A\u001b[B \r"), [
      { name: "up" }, { name: "down" }, { name: "space" }, { name: "enter" },
    ]);
    assert.deepEqual(parseKeys("a\u007f"), [{ name: "char", char: "a" }, { name: "backspace" }]);
    assert.deepEqual(parseKeys("\u001b"), [{ name: "cancel" }]);
    assert.deepEqual(parseKeys("\u0003"), [{ name: "cancel" }]);
    assert.deepEqual(parseKeys("\u0001"), [{ name: "all" }]);
  });
});
