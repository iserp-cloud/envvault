export type EnvRow = { id: string; key: string; value: string; revealed: boolean };

export function toRows(env: Record<string, string>): EnvRow[] {
  return Object.keys(env)
    .sort()
    .map((key, i) => ({
      id: `${key}-${i}`,
      key,
      value: env[key] ?? "",
      revealed: false,
    }));
}

export function rowsToEnv(rows: EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    env[key] = row.value;
  }
  return env;
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
