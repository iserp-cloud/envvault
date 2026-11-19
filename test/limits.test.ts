import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_BODY_BYTES, bodyLimitViolation } from "../src/security.js";

describe("request body limit", () => {
  it("lets ordinary requests through", () => {
    assert.equal(bodyLimitViolation("POST", "1200", undefined), null);
    assert.equal(bodyLimitViolation("POST", String(MAX_BODY_BYTES), undefined), null);
    assert.equal(bodyLimitViolation("POST", undefined, undefined), null); // no body declared
    assert.equal(bodyLimitViolation("GET", undefined, "chunked"), null);
  });

  it("rejects oversized or malformed lengths with 413", () => {
    assert.equal(bodyLimitViolation("POST", String(MAX_BODY_BYTES + 1), undefined)?.status, 413);
    assert.equal(bodyLimitViolation("POST", "not-a-number", undefined)?.status, 413);
    assert.equal(bodyLimitViolation("PUT", "-5", undefined)?.status, 413);
  });

  it("requires a declared length for chunked uploads (411)", () => {
    assert.equal(bodyLimitViolation("POST", undefined, "chunked")?.status, 411);
    assert.equal(bodyLimitViolation("POST", "", "chunked")?.status, 411);
  });
});
