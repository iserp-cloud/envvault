import { existsSync } from "node:fs";
import { SCHEMA_VERSION } from "./migrate.js";
import { assertDbTarget, isPostgresTarget, normalizePostgresUrl } from "./postgres.js";

export { SCHEMA_VERSION };

/**
 * The schema version a database is at, read without changing anything.
 * `null` means a database that has never been set up (no file, no tables, no version row).
 */
export async function peekSchemaVersion(target: string): Promise<string | null> {
  assertDbTarget(target);
  if (isPostgresTarget(target)) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: normalizePostgresUrl(target) });
    await client.connect();
    try {
      const res = await client.query("SELECT value FROM settings WHERE key = 'schema_version'");
      return (res.rows[0]?.value as string | undefined) ?? null;
    } catch (err) {
      if ((err as { code?: string }).code === "42P01") return null; // settings table doesn't exist
      throw err;
    } finally {
      await client.end();
    }
  }
  if (!existsSync(target)) return null;
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(target, { readonly: true, fileMustExist: true });
  try {
    const row = sqlite.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    sqlite.close();
  }
}

export { describeDbTarget as describeTarget } from "@envvault/shared";
