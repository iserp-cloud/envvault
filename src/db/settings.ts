import { type Kysely } from "kysely";
import type { Database as DbSchema } from "./schema.js";

export async function getSetting(db: Kysely<DbSchema>, key: string): Promise<string | null> {
  const row = await db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  return row?.value ?? null;
}

export async function setSetting(
  db: Kysely<DbSchema>,
  key: string,
  value: string,
): Promise<void> {
  await db
    .insertInto("settings")
    .values({ key, value })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
    .execute();
}

export async function deleteSettings(db: Kysely<DbSchema>, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await db.deleteFrom("settings").where("key", "in", keys).execute();
}
