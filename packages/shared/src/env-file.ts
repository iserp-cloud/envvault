/** Parse and serialize .env file contents */

export type EnvMap = Record<string, string>;

export function parseEnv(content: string): EnvMap {
  const result: EnvMap = {};

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
    }

    if (key) result[key] = value;
  }

  return result;
}

export function serializeEnv(env: EnvMap): string {
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

export function mergeEnv(base: EnvMap, overlay: EnvMap): EnvMap {
  return { ...base, ...overlay };
}
