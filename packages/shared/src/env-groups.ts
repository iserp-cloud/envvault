import { parseEnv, serializeEnv, type EnvMap } from "./env-file.js";
import { DEFAULT_GROUP, normalizeGroup, validateGroupName } from "./groups.js";

/**
 * Groups in a .env file are written as a line of their own: `# @group db`. It applies to the keys below it,
 * until the next marker; `# @group default` goes back to the default group, and keys above the first marker
 * are in it. Everything else (plain comments, blank lines, commented-out keys) has no meaning, so a formatter
 * that reflows the file cannot regroup keys.
 */
const MARKER = /^\s*#\s*@group(?:\s+(.*?))?\s*$/i;

export type GroupSection = { group: string; text: string };

/** Split a .env file at its `# @group` lines. `group` is "" for the default group. Throws, naming the line, on a bad name. */
export function splitGroupSections(content: string): GroupSection[] {
  const sections: GroupSection[] = [{ group: "", text: "" }];
  content.split(/\r?\n/).forEach((line, i) => {
    const m = MARKER.exec(line);
    if (!m) {
      sections[sections.length - 1]!.text += `${line}\n`;
      return;
    }
    const name = (m[1] ?? "").trim();
    const group = normalizeGroup(name);
    const problem = !name
      ? "needs a group name, e.g. # @group db"
      : name.toLowerCase() === DEFAULT_GROUP
        ? null
        : validateGroupName(name);
    if (problem) throw new Error(`Line ${i + 1}: "# @group ${name}" ${problem}`);
    sections.push({ group, text: "" });
  });
  return sections;
}

/** True when the text has at least one `# @group` marker. */
export function hasGroupMarkers(content: string): boolean {
  return content.split(/\r?\n/).some((l) => MARKER.test(l));
}

/**
 * Parse a .env file that may carry `# @group` markers. `parse` reads one section's text (so a caller keeps its own
 * rules for quoting); keys with no group come back without one.
 */
export function parseEnvGroups(
  content: string,
  parse: (text: string) => EnvMap = parseEnv,
): { vars: EnvMap; groups: Record<string, string> } {
  const vars: EnvMap = {};
  const groups: Record<string, string> = {};
  for (const { group, text } of splitGroupSections(content)) {
    for (const [key, value] of Object.entries(parse(text))) {
      vars[key] = value;
      if (group) groups[key] = group;
      else delete groups[key];
    }
  }
  return { vars, groups };
}

/** The .env text for an environment: the default keys first, then one `# @group name` section per group. */
export function serializeEnvGroups(vars: EnvMap, groups: Record<string, string>): string {
  const by = new Map<string, EnvMap>();
  for (const key of Object.keys(vars)) {
    const g = normalizeGroup(groups[key]);
    if (!by.has(g)) by.set(g, {});
    by.get(g)![key] = vars[key]!;
  }
  const parts: string[] = [];
  const base = by.get("");
  if (base) parts.push(serializeEnv(base));
  for (const g of [...by.keys()].filter(Boolean).sort()) {
    parts.push(`# @group ${g}\n${serializeEnv(by.get(g)!)}`);
  }
  return parts.join("\n");
}
