/** Shared namespace for usernames + organization slugs (GitHub-style). */

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** Soft cap on orgs a single user may own (abuse / spam guard). */
export const MAX_OWNED_ORGS = 10;

/** Soft cap on environments per project. */
export const MAX_ENVS_PER_PROJECT = 20;

/** Default environment created with every project. */
export const DEFAULT_ENV_NAME = "default";

export function normalizeEnvName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!name) throw new Error("Environment name is required");
  if (!SLUG_RE.test(name)) {
    throw new Error(
      "Environment name must be 2–32 chars: letters, numbers, _ or - (start with letter/number)",
    );
  }
  return name;
}

/** Names that must never be taken by a user or org. */
const RESERVED = new Set([
  "personal",
  "local",
  "admin",
  "administrator",
  "api",
  "app",
  "apps",
  "auth",
  "cli",
  "create",
  "dashboard",
  "env",
  "envvault",
  "help",
  "login",
  "logout",
  "me",
  "new",
  "null",
  "org",
  "orgs",
  "rpc",
  "settings",
  "signup",
  "support",
  "system",
  "tenant",
  "tenants",
  "undefined",
  "user",
  "users",
  "vault",
  "www",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED.has(slug.toLowerCase());
}

export function normalizeSlug(raw: string, label = "Name"): string {
  const slug = raw.trim().toLowerCase();
  if (!slug) throw new Error(`${label} is required`);
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `${label} must be 2–32 chars: letters, numbers, _ or - (start with letter/number)`,
    );
  }
  if (isReservedSlug(slug)) {
    throw new Error(`${label} is reserved`);
  }
  // Block personal-tenant id style and internal prefixes
  if (slug.startsWith("p_") || slug.startsWith("t_")) {
    throw new Error(`${label} cannot start with p_ or t_`);
  }
  return slug;
}

/** Turn a legacy display name into a candidate slug (may need collision suffix). */
export function slugifyLegacyName(name: string, fallback: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (base && SLUG_RE.test(base) && !isReservedSlug(base)) return base;
  const fb = fallback
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "")
    .slice(0, 24);
  return fb && SLUG_RE.test(fb) ? fb : `org-${fallback.slice(0, 12).toLowerCase()}`;
}
