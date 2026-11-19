import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openDb } from "../src/db/index.js";
import { isUniqueViolation } from "../src/db/errors.js";
import { insertNewEnvironment, insertNewProject } from "../src/db/store.js";

describe("creating a project or environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "envvault-race-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let db: Awaited<ReturnType<typeof openDb>>;
  before(async () => {
    db = await openDb(join(dir, "v.db"));
  });
  const box = (n: string) => ({ v: 1, iv: n, ct: n }) as never;
  const env = (name: string, payload: string) => ({
    tenantId: "t", projectName: "p", name, updatedAt: "2026-01-01T00:00:00Z", payload: box(payload), updatedBy: "u",
  });

  it("refuses a duplicate instead of overwriting it", async () => {
    await insertNewProject(db, { tenantId: "t", name: "p", updatedAt: "x" });
    await assert.rejects(insertNewProject(db, { tenantId: "t", name: "p", updatedAt: "y" }), (e) => isUniqueViolation(e));
    await insertNewEnvironment(db, env("default", "first"));
    await assert.rejects(insertNewEnvironment(db, env("default", "second")), (e) => isUniqueViolation(e));
    const row = await db.selectFrom("environments").select("payload").where("name", "=", "default").executeTakeFirstOrThrow();
    assert.match(row.payload, /first/, "the first writer's ciphertext is untouched");
  });

  it("leaves nothing behind when a transaction fails halfway", async () => {
    await assert.rejects(
      db.transaction().execute(async (trx) => {
        await insertNewEnvironment(trx, env("staging", "a"));
        await insertNewEnvironment(trx, env("staging", "b")); // the second insert collides
      }),
    );
    const rows = await db.selectFrom("environments").select("name").where("name", "=", "staging").execute();
    assert.equal(rows.length, 0, "the first insert was rolled back, so a retry isn't blocked");
  });

  it("only one of two simultaneous creations wins", async () => {
    const results = await Promise.allSettled(
      ["x", "y"].map((who) => db.transaction().execute((trx) => insertNewEnvironment(trx, env("prod", who)))),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(isUniqueViolation(loser.reason));
  });
});

describe("database target", () => {
  it("refuses a misspelled URL instead of using it as a file name", async () => {
    await assert.rejects(openDb("postgressql://u:secretpw@db:5432/x"), /unsupported scheme "postgressql:\/\//);
    await assert.rejects(openDb("mysql://u:p@db/x"), /unsupported scheme "mysql:\/\//);
  });

  it("never puts the password in the error", async () => {
    await assert.rejects(openDb("postgressql://u:hunter2hunter2@db/x"), (e: Error) => !e.message.includes("hunter2"));
  });
});
