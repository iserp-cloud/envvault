import { groupMarker } from "./env-groups.js";
import { DEFAULT_GROUP, MAX_GROUPS_PER_ENV, normalizeGroup, validateGroupName } from "./groups.js";

export type CheckIssue = {
  line: number;
  level: "error" | "warning";
  /** A stable name, for scripts and agents to branch on. */
  code: string;
  message: string;
};

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_RE = /PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|_KEY$/i;
// a group that sounds like plain settings is a likely ConfigMap, which anyone who can read ConfigMaps can read
const CONFIGLIKE_GROUP_RE = /config|setting|public|^cm$|^app$/;

/**
 * Check .env text the way `push` would read it, without sending anything: problems that make a line be ignored,
 * change a value, or put a key in the wrong group. Errors are things `push --groups` would refuse or silently drop.
 */
export function checkEnvText(text: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const add = (line: number, level: CheckIssue["level"], code: string, message: string) =>
    issues.push({ line, level, code, message });

  let group = "";
  const seen = new Map<string, { line: number; group: string }>();
  const groups = new Set<string>();

  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line) return;

    const marker = groupMarker(raw);
    if (marker !== null) {
      if (!marker) return add(n, "error", "group-name-missing", "`# @group` needs a name, e.g. `# @group db`.");
      if (marker.toLowerCase() === DEFAULT_GROUP) {
        group = "";
        return;
      }
      const problem = validateGroupName(marker);
      if (problem) return add(n, "error", "group-name-invalid", `\`# @group ${marker}\`: ${problem}`);
      group = normalizeGroup(marker);
      groups.add(group);
      return;
    }
    if (line.startsWith("#")) return;

    const eq = line.indexOf("=");
    if (eq === -1) {
      return add(n, "error", "not-key-value", `Not KEY=value, so it is ignored: "${line.slice(0, 40)}".`);
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (/^export\s/.test(key)) {
      return add(n, "error", "export-prefix", `Remove the \`export\` prefix: write ${key.replace(/^export\s+/, "")}=…`);
    }
    if (!KEY_RE.test(key)) {
      return add(n, "error", "key-invalid", `"${key}" is not a usable key name (letters, digits and _, not starting with a digit).`);
    }
    if (key !== key.toUpperCase()) {
      add(n, "warning", "key-not-uppercase", `${key} is not UPPER_CASE; most tools expect upper-case environment variable names.`);
    }

    const quote = value[0];
    if ((quote === '"' || quote === "'") && !(value.length > 1 && value.endsWith(quote))) {
      add(n, "error", "unterminated-quote", `${key}: the value starts with ${quote} but does not end with one, so the quote becomes part of the value.`);
    } else if (quote !== '"' && quote !== "'" && /\s#/.test(value)) {
      add(n, "warning", "inline-comment", `${key}: " #…" at the end of a value is NOT a comment here; it becomes part of the value. Put the comment on its own line, or quote the value.`);
    }
    if (value === "") add(n, "warning", "empty-value", `${key} has an empty value.`);

    const before = seen.get(key);
    if (before) {
      add(n, "warning", "duplicate-key", `${key} is also set on line ${before.line}; the later one wins${before.group !== group ? ` and its group becomes ${group || "default"}` : ""}.`);
    }
    seen.set(key, { line: n, group });

    if (group && CONFIGLIKE_GROUP_RE.test(group) && SENSITIVE_RE.test(key)) {
      add(n, "warning", "sensitive-in-config-group", `${key} looks sensitive but is in group "${group}", which reads like plain settings; if a link writes that group as a ConfigMap, anyone who can read ConfigMaps can read it. Use a Secret link, or move the key.`);
    }
  });

  if (groups.size > MAX_GROUPS_PER_ENV) {
    add(1, "error", "too-many-groups", `${groups.size} groups; an environment can have at most ${MAX_GROUPS_PER_ENV}.`);
  }
  return issues;
}

/** Errors first, then warnings, each in line order. */
export function sortIssues(issues: CheckIssue[]): CheckIssue[] {
  return [...issues].sort((a, b) => (a.level === b.level ? a.line - b.line : a.level === "error" ? -1 : 1));
}
