/** True when a database error is a duplicate-key violation (Postgres 23505, or a SQLite constraint). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === "23505") return true;
  if (typeof e?.code === "string" && e.code.startsWith("SQLITE_CONSTRAINT")) return true;
  return typeof e?.message === "string" && /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(e.message);
}
