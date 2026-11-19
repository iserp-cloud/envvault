import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database as DbSchema } from "./db/schema.js";
import { countUsers, deleteSettings, getSetting } from "./db/store.js";

/**
 * First-run protection. Until the first (admin) account exists, signup requires a
 * setup token — ENVVAULT_SETUP_TOKEN if set, otherwise one generated at startup and
 * printed to the server log (shared across replicas via the database). This stops a
 * stranger who reaches a freshly deployed hub from claiming the admin account.
 */

export async function expectedSetupToken(db: Kysely<DbSchema>): Promise<string | undefined> {
  const fromEnv = process.env.ENVVAULT_SETUP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return (await getSetting(db, "setup_token")) ?? undefined;
}

/**
 * Called at server start. Returns the generated token to print, or null when there
 * is nothing to print (already initialised, or the operator supplied one).
 */
export async function ensureSetupToken(db: Kysely<DbSchema>): Promise<string | null> {
  if ((await countUsers(db)) > 0) {
    await deleteSettings(db, ["setup_token"]);
    return null;
  }
  if (process.env.ENVVAULT_SETUP_TOKEN?.trim()) return null;

  // Replicas starting at once must agree: first writer wins, everyone re-reads.
  await db
    .insertInto("settings")
    .values({ key: "setup_token", value: randomBytes(18).toString("base64url") })
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
  return (await getSetting(db, "setup_token")) ?? null;
}
