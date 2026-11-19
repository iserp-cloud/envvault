import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateRecoveryKey,
  validateHandle,
  validateNewPassword,
  validateRecoveryKeyFormat,
} from "@envvault/shared";

describe("input validation", () => {
  it("requires passwords of at least 8 characters", () => {
    assert.ok(validateNewPassword("1234567"));
    assert.equal(validateNewPassword("12345678"), null);
    assert.ok(validateNewPassword("        "), "whitespace-only is rejected");
    assert.ok(validateNewPassword("x".repeat(257)));
  });

  it("applies the hub's naming rules to usernames and org names", () => {
    assert.equal(validateHandle("jane_doe-1"), null);
    for (const bad of ["", " ", "a", "-bad", "Has Space", "admin", "p_x", "x".repeat(33)]) {
      assert.ok(validateHandle(bad), `rejects ${JSON.stringify(bad)}`);
    }
  });

  it("checks the recovery key format before any network call", () => {
    assert.equal(validateRecoveryKeyFormat(generateRecoveryKey()), null);
    assert.ok(validateRecoveryKeyFormat(""));
    assert.ok(validateRecoveryKeyFormat("ABCD-EFGH"));
  });
});
