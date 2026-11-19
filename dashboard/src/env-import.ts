/** Auto-detect and parse pasted .env or JSON into a flat key/value map */

export type ImportFormat = "env" | "json";

export type ImportResult = {
  format: ImportFormat;
  env: Record<string, string>;
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

function flattenJsonValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function parseJsonEnv(parsed: unknown): Record<string, string> {
  const result: Record<string, string> = {};

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (Array.isArray(item) && item.length >= 2) {
        const key = String(item[0]).trim();
        if (key) result[key] = flattenJsonValue(item[1]);
        continue;
      }
      if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        const key = String(row.key ?? row.name ?? row.KEY ?? "").trim();
        if (key) result[key] = flattenJsonValue(row.value ?? row.VALUE ?? "");
      }
    }
    return result;
  }

  if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.trim()) continue;
      result[key.trim()] = flattenJsonValue(value);
    }
    return result;
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
      const env = parseJsonEnv(parsed);
      if (!Object.keys(env).length) throw new Error("JSON contained no keys");
      return { format: "json", env };
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error("Invalid JSON");
      }
      throw err;
    }
  }

  if (looksLikeEnv(text) || text.includes("=")) {
    const env = parseDotEnv(text);
    if (!Object.keys(env).length) {
      throw new Error("No KEY=value pairs found");
    }
    return { format: "env", env };
  }

  // Last resort: try JSON, then env
  try {
    const parsed = JSON.parse(text) as unknown;
    const env = parseJsonEnv(parsed);
    if (Object.keys(env).length) return { format: "json", env };
  } catch {
    // ignore
  }

  const env = parseDotEnv(text);
  if (!Object.keys(env).length) {
    throw new Error("Could not detect .env or JSON format");
  }
  return { format: "env", env };
}

export function serializeEnvExport(env: Record<string, string>): string {
  const keys = Object.keys(env).sort();
  return (
    keys
      .map((key) => {
        const value = env[key] ?? "";
        const needsQuotes = /[\s#"']/.test(value) || value === "";
        if (needsQuotes) {
          return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        }
        return `${key}=${value}`;
      })
      .join("\n") + (keys.length ? "\n" : "")
  );
}

export function serializeJsonExport(env: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    sorted[key] = env[key] ?? "";
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
