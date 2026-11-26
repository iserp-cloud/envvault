/** `group` is empty for the default group. */
export type EnvRow = { id: string; key: string; value: string; revealed: boolean; group: string };

export function toRows(env: Record<string, string>, groups: Record<string, string> = {}): EnvRow[] {
  return Object.keys(env)
    .sort()
    .map((key, i) => ({
      id: `${key}-${i}`,
      key,
      value: env[key] ?? "",
      revealed: false,
      group: groups[key] ?? "",
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

/** The group of every key that is not in the default group, for keys that are present. */
export function rowsToGroups(rows: EnvRow[]): Record<string, string> {
  const groups: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    const group = row.group.trim().toLowerCase();
    if (key && group && group !== "default") groups[key] = group;
  }
  return groups;
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
