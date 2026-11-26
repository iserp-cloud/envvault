/**
 * Auto-detect and parse pasted .env or JSON into key/value pairs, and the group of each key when the text names
 * them: `# @group name` lines in .env, a nested object per group in JSON.
 */
import { normalizeGroup, serializeEnvGroups, splitGroupSections, validateGroupName } from "@envvault/shared";

export type ImportFormat = "env" | "json";

export type ImportResult = {
  format: ImportFormat;
  env: Record<string, string>;
  /** The group of each key that is in a named group. Empty for text that names none. */
  groups: Record<string, string>;
  /** True when the text names groups at all, even only the default one: the file then decides every key's group. */
  hasGroups: boolean;
};

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }

    if (key) result[key] = value;
  }

  return result;
}

function parseDotEnvGroups(content: string): { env: Record<string, string>; groups: Record<string, string>; hasGroups: boolean } {
  const sections = splitGroupSections(content);
  const env: Record<string, string> = {};
  const groups: Record<string, string> = {};
  for (const { group, text } of sections) {
    for (const [key, value] of Object.entries(parseDotEnv(text))) {
      env[key] = value;
      if (group) groups[key] = group;
      else delete groups[key];
    }
  }
  return { env, groups, hasGroups: sections.length > 1 };
}

function flattenJsonValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const isScalar = (v: unknown) => v == null || ["string", "number", "boolean"].includes(typeof v);

/** An object whose name is a group name and whose values are all plain values is a group of keys. */
function asGroup(name: string, value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (name !== "default" && validateGroupName(name) !== null) return null;
  const inner = value as Record<string, unknown>;
  return Object.values(inner).every(isScalar) ? inner : null;
}

function parseJsonEnv(parsed: unknown): { env: Record<string, string>; groups: Record<string, string>; hasGroups: boolean } {
  const env: Record<string, string> = {};
  const groups: Record<string, string> = {};
  let hasGroups = false;

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (Array.isArray(item) && item.length >= 2) {
        const key = String(item[0]).trim();
        if (key) env[key] = flattenJsonValue(item[1]);
        continue;
      }
      if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        const key = String(row.key ?? row.name ?? row.KEY ?? "").trim();
        if (key) env[key] = flattenJsonValue(row.value ?? row.VALUE ?? "");
      }
    }
    return { env, groups, hasGroups };
  }

  if (parsed && typeof parsed === "object") {
    // Top-level text values are the default group. An object under a group name holds that group's keys; any
    // other object stays what it always was, a value holding JSON text.
    for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key) continue;
      const inner = asGroup(key, value);
      if (!inner) {
        env[key] = flattenJsonValue(value);
        delete groups[key];
        continue;
      }
      hasGroups = true;
      const group = normalizeGroup(key);
      for (const [k, v] of Object.entries(inner)) {
        const name = k.trim();
        if (!name) continue;
        env[name] = flattenJsonValue(v);
        if (group) groups[name] = group;
        else delete groups[name];
      }
    }
    return { env, groups, hasGroups };
  }

  throw new Error("JSON must be an object or an array of pairs");
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}

function looksLikeEnv(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const envLike = lines.filter((l) => !l.startsWith("#") && /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l));
  return envLike.length > 0 && envLike.length >= Math.ceil(lines.filter((l) => !l.startsWith("#")).length * 0.5);
}

export function detectAndParseImport(raw: string): ImportResult {
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) {
    throw new Error("Nothing to import");
  }

  if (looksLikeJson(text)) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const found = parseJsonEnv(parsed);
      if (!Object.keys(found.env).length) throw new Error("JSON contained no keys");
      return { format: "json", ...found };
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error("Invalid JSON");
      }
      throw err;
    }
  }

  if (looksLikeEnv(text) || text.includes("=")) {
    const found = parseDotEnvGroups(text);
    if (!Object.keys(found.env).length) {
      throw new Error("No KEY=value pairs found");
    }
    return { format: "env", ...found };
  }

  // Last resort: try JSON, then env
  try {
    const parsed = JSON.parse(text) as unknown;
    const found = parseJsonEnv(parsed);
    if (Object.keys(found.env).length) return { format: "json", ...found };
  } catch {
    // ignore
  }

  const found = parseDotEnvGroups(text);
  if (!Object.keys(found.env).length) {
    throw new Error("Could not detect .env or JSON format");
  }
  return { format: "env", ...found };
}

export function serializeEnvExport(env: Record<string, string>, groups: Record<string, string> = {}): string {
  return serializeEnvGroups(env, groups);
}

/** Flat `{KEY: value}` when no key has a group; otherwise the default keys on top and one object per group. */
export function serializeJsonExport(env: Record<string, string>, groups: Record<string, string> = {}): string {
  const out: Record<string, string | Record<string, string>> = {};
  const named = new Map<string, Record<string, string>>();
  for (const key of Object.keys(env).sort()) {
    const g = normalizeGroup(groups[key]);
    if (!g) {
      out[key] = env[key] ?? "";
      continue;
    }
    if (!named.has(g)) named.set(g, {});
    named.get(g)![key] = env[key] ?? "";
  }
  for (const g of [...named.keys()].sort()) out[g] = named.get(g)!;
  return `${JSON.stringify(out, null, 2)}\n`;
}
