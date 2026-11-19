export type EnvChange = {
  key: string;
  /** What restoring would do to the current environment. */
  kind: "added" | "removed" | "changed";
  /** Value in the current environment (absent for "added"). */
  current?: string;
  /** Value in the older version (absent for "removed"). */
  version?: string;
};

/** What restoring `version` over `current` would change, sorted by key. */
export function diffEnv(
  current: Record<string, string>,
  version: Record<string, string>,
): EnvChange[] {
  const out: EnvChange[] = [];
  const keys = new Set([...Object.keys(current), ...Object.keys(version)]);
  for (const key of [...keys].sort()) {
    const inCurrent = Object.prototype.hasOwnProperty.call(current, key);
    const inVersion = Object.prototype.hasOwnProperty.call(version, key);
    if (inCurrent && inVersion) {
      if (current[key] !== version[key]) {
        out.push({ key, kind: "changed", current: current[key], version: version[key] });
      }
    } else if (inVersion) {
      out.push({ key, kind: "added", version: version[key] });
    } else {
      out.push({ key, kind: "removed", current: current[key] });
    }
  }
  return out;
}
