/**
 * Key groups. An environment's keys can be sorted into named groups, and each Kubernetes link takes one
 * group (a Secret or a ConfigMap). The group of every key lives inside the encrypted payload, so the
 * hub never learns how an environment is organised.
 *
 * A key with no group is in the `default` group. An environment without any grouped key is sealed as a
 * plain JSON object, exactly as before groups existed, so every older client and operator still reads it.
 */

/** The group of every key that has none. It is a name a link can ask for, but never stored on a key. */
export const DEFAULT_GROUP = "default";

export const GROUP_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Most different groups one environment may use. */
export const MAX_GROUPS_PER_ENV = 30;

/** Null when `raw` is a usable group name. Letters and digits are lower case so a name matches however it was typed. */
export function validateGroupName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Group name is required";
  if (!GROUP_RE.test(name)) {
    return "Group names are 1–40 characters: lower-case letters, digits or - (start with a letter or digit)";
  }
  return null;
}

/** A group name as a person typed it, ready to store: trimmed and lower-cased. `default` and empty mean "no group". */
export function normalizeGroup(raw: string | undefined | null): string {
  const name = (raw ?? "").trim().toLowerCase();
  return name === DEFAULT_GROUP ? "" : name;
}

/** The group of one key, `default` when it has none. */
export function groupOf(groups: Record<string, string>, key: string): string {
  return groups[key] || DEFAULT_GROUP;
}

/** Most group names one environment's registry may hold. */
export const MAX_LABELS_PER_ENV = 50;

/** The registry of an environment: the group names offered for its keys, valid, unique and sorted. Invalid ones are dropped. */
export function cleanLabels(labels: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of labels) {
    const name = raw.trim().toLowerCase();
    if (name !== DEFAULT_GROUP && validateGroupName(name) === null) out.add(name);
  }
  return [...out].sort().slice(0, MAX_LABELS_PER_ENV);
}

/** Every group name a person can pick for a key: the registry plus any group already in use, sorted, never `default`. */
export function knownGroups(labels: readonly string[], groups: Record<string, string>): string[] {
  return cleanLabels([...labels, ...Object.values(groups)]);
}

/** Keeps only groups that still have a key and are really groups: a deleted key takes its group with it. */
export function pruneGroups(vars: Record<string, string>, groups: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(groups).sort()) {
    const g = normalizeGroup(groups[key]);
    if (g && Object.prototype.hasOwnProperty.call(vars, key)) out[key] = g;
  }
  return out;
}

/** The keys one group holds, as a plain map. */
export function keysInGroup(vars: Record<string, string>, groups: Record<string, string>, group: string): Record<string, string> {
  const want = normalizeGroup(group) || DEFAULT_GROUP;
  const out: Record<string, string> = {};
  for (const k of Object.keys(vars)) if (groupOf(groups, k) === want) out[k] = vars[k]!;
  return out;
}

/** Every group in use with its key count, `default` first. A group a link asks for that has no keys is not listed. */
export function groupCounts(vars: Record<string, string>, groups: Record<string, string>): { group: string; keys: number }[] {
  const counts = new Map<string, number>();
  for (const k of Object.keys(vars)) {
    const g = groupOf(groups, k);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([group, keys]) => ({ group, keys }))
    .sort((a, b) => (a.group === DEFAULT_GROUP ? -1 : b.group === DEFAULT_GROUP ? 1 : a.group.localeCompare(b.group)));
}
