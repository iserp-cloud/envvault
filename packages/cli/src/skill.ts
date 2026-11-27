/**
 * The text `envvault skill` prints and `envvault skill install` writes: how to use the CLI and write a correct
 * .env, for a coding agent. It lives here (not in a .md file) so it is bundled with the CLI and always matches
 * the installed version.
 */

export const AGENTS_START = "<!-- envvault:start -->";
export const AGENTS_END = "<!-- envvault:end -->";

const SKILL = `---
name: envvault
description: Use when reading, writing or syncing environment variables or .env files with EnvVault (the \`envvault\` CLI) - pulling or pushing a .env, adding or changing one key, putting keys in groups for Kubernetes, or checking a .env file before it is pushed.
---

# EnvVault (CLI {{version}})

EnvVault stores each environment's variables encrypted; the server never sees values. The \`envvault\` CLI syncs
them with a local \`.env\` file. Run \`envvault --help\` or \`envvault <command> --help\` for exact flags.

## Safety rules (follow these first)

- Never print, log, echo or paste secret values: not in chat, commits, comments or test output. \`envvault get\`
  and \`pull\` expose values; use them only when the task needs the value, and do not repeat it back.
- Never commit a \`.env\` file, and never remove \`.env\` from \`.gitignore\`.
- \`envvault push\` REPLACES the whole environment with the file: a key missing from the file is removed. For
  one key use \`envvault set KEY=value\` instead. Pull before you push so you do not overwrite someone's change.
- Do not add \`--yes\` (skips the empty-file confirmation) or \`--create\` (creates projects/environments) unless
  the user asked for it.
- Do not log in, sign up or change access (\`access grant/revoke\`, \`rotate\`) on your own. If you see
  "Not logged in", tell the user to run \`envvault login\`.

## Which project and environment

A directory can have an \`envvault.toml\` (or \`envvault.json\`) naming the project, environment and file; the CLI
finds the nearest one in the current or a parent directory, so plain \`envvault pull\` / \`push\` need no flags there.
Otherwise pass \`-p <project> -e <environment>\` (the environment defaults to \`default\`) and \`-f <file>\`.
\`-t <workspace>\` picks a workspace. From the folder holding the config, \`envvault pull\` / \`push\` sync every target;
\`envvault tree list --json\` shows them.

## Writing a correct .env

\`\`\`
LOG_LEVEL=info
GREETING="hello world"        # quote values with spaces or #
# a comment goes on its own line, never after a value

# @group db
DATABASE_URL=postgres://user:pass@host/db
DB_POOL=10
\`\`\`

- One \`KEY=value\` per line. Keys are letters, digits and \`_\`, not starting with a digit; use UPPER_CASE.
- No \`export\` prefix. No spaces around the key. Quote a value that has spaces or \`#\`; an unquoted
  \`value # note\` keeps \` # note\` as part of the value (inline comments are NOT supported).
- Lines starting with \`#\` are comments. A commented-out \`# KEY=value\` is ignored, never imported.
- Do not invent or guess values. Use placeholders only in \`.env.example\`, which is safe to commit.
- Check a file before pushing: \`envvault check .env\` (add \`--json\` for structured output). It exits 1 on errors.

## Key groups

Keys can be sorted into groups; a Kubernetes link writes ONE group as a Secret or ConfigMap. Keys in no group are
in the group \`default\`. Group names are lowercase letters, digits and \`-\` (max 40 characters, starting with a letter
or digit); \`default\` cannot be named as a real group.

- In a \`.env\` file, a line \`# @group db\` puts the keys below it in \`db\` until the next marker.
  \`# @group default\` goes back to the default group. Only a \`# @group\` line counts; ordinary comments and blank
  lines never change a group.
- \`envvault push --groups\` reads those markers (the file's groups become the environment's groups; a key under no
  marker goes back to \`default\`). \`envvault pull --groups\` writes them. WITHOUT \`--groups\` a push ignores the
  markers (it tells you) and the keys that stay keep the groups they have.
- \`envvault set KEY=value --group db\` sets the group of the keys being set; \`--group default\` clears it.
- Put secrets in a Secret link. A group that a ConfigMap link writes is readable by anyone who can read
  ConfigMaps in that namespace, so keep passwords, tokens and keys out of it.
- Group names, the list of names and the markers are never written to the cluster.

## Everyday commands

| Task | Command |
|---|---|
| Download the environment to the file | \`envvault pull\` (\`--merge\` keeps keys that are only in the file) |
| Upload the file | \`envvault check .env\` then \`envvault push\` |
| Change or add one key | \`envvault set KEY=value\` |
| Remove a key | \`envvault unset KEY\` |
| Read one value | \`envvault get KEY\` |
| Read everything as JSON | \`envvault get --json\` (includes values; groups and the group list) |
| List environments | \`envvault env list --json\` |
| Earlier versions | \`envvault history --json\`, \`envvault history restore <n>\` |
| What a monorepo syncs | \`envvault tree list --json\` |

Add \`--json\` to \`get\`, \`push\` and \`pull\` (single target) when a script or agent reads the result.

## Common errors

- "Not logged in" / "invalid auth token": the user must run \`envvault login\`.
- "not found or no access": the project or environment does not exist, or the account cannot see it. The hub
  does not say which. Do not retry with \`--create\` unless asked.
- "changed by someone else": pull the latest, redo the change, try again.
- "key groups, which this caller cannot handle" / an update message: the CLI is older than the environment's data;
  update it (\`npm i -g @iserp/envvault\`).
- A pushed file that "has no variables": the push would empty the environment; confirm with the user.
`;

const AGENTS = `<!-- envvault:start -->
## EnvVault (environment variables)

Environment variables are managed with the \`envvault\` CLI. Run \`envvault skill\` for the full guide.

- Never print, log or commit secret values, and never commit \`.env\` files.
- \`envvault push\` replaces the whole environment from the file; use \`envvault set KEY=value\` for one key, and
  \`envvault pull\` first.
- Check a file before pushing: \`envvault check .env\`.
- Groups in a \`.env\` are \`# @group name\` lines, read only with \`push --groups\` / written by \`pull --groups\`.
  Keep secrets out of groups that a ConfigMap link writes.
- Do not log in, create projects, or change access without being asked.
<!-- envvault:end -->
`;

/** The full skill, as a Claude Code SKILL.md (with its front matter). */
export function skillText(version: string): string {
  return SKILL.replace("{{version}}", version);
}

/** The short block for AGENTS.md, between its two marker comments. */
export function agentsBlock(): string {
  return AGENTS;
}

/** AGENTS.md with the EnvVault block added or refreshed; text outside the markers is never touched. */
export function withAgentsBlock(existing: string | null): string {
  const block = agentsBlock();
  if (existing === null || !existing.trim()) return block;
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + block.trimEnd() + existing.slice(end + AGENTS_END.length);
  }
  return `${existing.replace(/\s*$/, "")}\n\n${block}`;
}
