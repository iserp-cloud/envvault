/**
 * Environment access: a base level plus optional capabilities.
 *
 * `read` decrypts, `write` also saves and restores. The capabilities are separate powers a
 * grant can carry on top of either: `delete` (the environment, its versions), `share` (grant
 * access, see who has it) and `rotate` (re-key and revoke). `manage` is the preset that holds
 * every capability, so a stored `manage` grant never lists them.
 */
export const ACL_LEVELS = ["read", "write", "manage"] as const;
export type AclLevel = (typeof ACL_LEVELS)[number];

export const ACL_CAPS = ["delete", "share", "rotate"] as const;
export type AclCap = (typeof ACL_CAPS)[number];

const LEVEL_ORDER: Record<AclLevel, number> = { read: 1, write: 2, manage: 3 };

export function isAclCap(value: string): value is AclCap {
  return (ACL_CAPS as readonly string[]).includes(value);
}

/** Parse the stored comma list, dropping anything unknown, in canonical order. */
export function parseCaps(stored: string | readonly string[]): AclCap[] {
  const list = typeof stored === "string" ? stored.split(",") : stored;
  const set = new Set(list.map((c) => c.trim()).filter(isAclCap));
  return ACL_CAPS.filter((c) => set.has(c));
}

/** What a grant can actually do: `manage` holds every capability. */
export function effectiveCaps(level: AclLevel, caps: string | readonly string[]): AclCap[] {
  return level === "manage" ? [...ACL_CAPS] : parseCaps(caps);
}

export function hasCap(level: AclLevel, caps: string | readonly string[], cap: AclCap): boolean {
  return effectiveCaps(level, caps).includes(cap);
}

/** A write grant with every capability is a manager; manage never stores a list. */
export function normalizeGrant(
  level: AclLevel,
  caps: readonly string[],
): { level: AclLevel; caps: AclCap[] } {
  const clean = parseCaps(caps);
  if (level === "manage" || (level === "write" && clean.length === ACL_CAPS.length)) {
    return { level: "manage", caps: [] };
  }
  return { level, caps: clean };
}

export function levelAtLeast(level: AclLevel, min: AclLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[min];
}

/** True when `holder` has everything `target` has: the level and each capability. */
export function covers(
  holder: { level: AclLevel; caps: string | readonly string[] },
  target: { level: AclLevel; caps: string | readonly string[] },
): boolean {
  if (!levelAtLeast(holder.level, target.level)) return false;
  const have = new Set(effectiveCaps(holder.level, holder.caps));
  return effectiveCaps(target.level, target.caps).every((c) => have.has(c));
}

export const CAP_LABELS: Record<AclCap, string> = {
  delete: "Delete",
  share: "Share",
  rotate: "Rotate keys",
};

/** "write", "write + delete", "manager" — for badges and the access list. */
export function describeAccess(level: AclLevel, caps: string | readonly string[]): string {
  if (level === "manage") return "manager";
  const list = parseCaps(caps);
  return list.length ? `${level} + ${list.join(", ")}` : level;
}
