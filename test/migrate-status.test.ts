import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openDb } from "../src/db/index.js";
import { describeTarget, peekSchemaVersion, SCHEMA_VERSION } from "../src/db/status.js";

describe("schema status", () => {
  const dir = mkdtempSync(join(tmpdir(), "envvault-migrate-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "vault.db");

  it("reports a database that was never set up, without creating it", async () => {
    assert.equal(await peekSchemaVersion(target), null);
    assert.equal(await peekSchemaVersion(target), null); // peeking did not create the file
  });

  it("is current after opening, and sees an older version", async () => {
    const db = await openDb(target); // opening migrates
    assert.equal(await peekSchemaVersion(target), SCHEMA_VERSION);
    await db.updateTable("settings").set({ value: "zk-4" }).where("key", "=", "schema_version").execute();
    assert.equal(await peekSchemaVersion(target), "zk-4");
    await db.destroy();
  });

  it("hides the password when printing a Postgres target", () => {
    assert.equal(describeTarget("postgresql://u:secret@db:5432/x"), "postgresql://u:***@db:5432/x");
    assert.ok(!describeTarget("postgresql://u:secret@db:5432/x").includes("secret"));
  });
});
