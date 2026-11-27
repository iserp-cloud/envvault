import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkEnvText, parseEnvGroups, sortIssues } from "@envvault/shared";
import pkg from "../../package.json" with { type: "json" };
import { agentsBlock, skillText, withAgentsBlock } from "../skill.js";
import { c, hint, info, printJson, rel, success } from "../ui.js";

type InstallOpts = { global?: boolean; target?: string; dir?: string };

function write(path: string, text: string): "created" | "updated" | "unchanged" {
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (before === text) return "unchanged";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return before === null ? "created" : "updated";
}

export function registerAgent(program: Command): void {
  const skill = program
    .command("skill")
    .description("Print the guide for coding agents: how to use EnvVault and write a correct .env")
    .action(() => {
      process.stdout.write(skillText(pkg.version));
    });

  skill
    .command("install")
    .description("Write the guide where agents look: .claude/skills/envvault/SKILL.md and an AGENTS.md section")
    .option("--global", "Install the Claude Code skill for your user (~/.claude/skills) instead of this project")
    .option("--target <which>", "claude, agents or all", "all")
    .option("-d, --dir <path>", "Project directory (default: the current one)")
    .action((opts: InstallOpts) => {
      const which = opts.target ?? "all";
      if (!["claude", "agents", "all"].includes(which)) throw new Error('--target must be "claude", "agents" or "all".');
      if (opts.global && which === "agents") throw new Error("--global installs the Claude Code skill only; drop --target agents.");
      const dir = resolve(opts.dir ?? process.cwd());

      if (which !== "agents") {
        const path = opts.global
          ? join(homedir(), ".claude", "skills", "envvault", "SKILL.md")
          : join(dir, ".claude", "skills", "envvault", "SKILL.md");
        const result = write(path, skillText(pkg.version));
        success(`${result === "unchanged" ? "Up to date" : result === "created" ? "Wrote" : "Updated"} ${opts.global ? path : rel(path)}`);
      }
      if (which !== "claude" && !opts.global) {
        const path = join(dir, "AGENTS.md");
        const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
        const next = withAgentsBlock(existing);
        const result = write(path, next.endsWith("\n") ? next : `${next}\n`);
        success(
          `${result === "unchanged" ? "Up to date" : existing === null ? "Wrote" : "Updated the EnvVault section of"} ${rel(path)}`,
        );
        if (existing !== null) hint("Only the block between the envvault markers is managed; the rest of the file is untouched.");
      }
      hint(`Re-run after upgrading the CLI to refresh it (this is version ${pkg.version}).`);
    });

  program
    .command("check")
    .description("Check .env files before pushing, without sending anything (exits 1 on errors)")
    .argument("[files...]", "Files to check (default: .env)")
    .option("--json", "Machine-readable output")
    .option("--strict", "Treat warnings as failures too")
    .action((files: string[], opts: { json?: boolean; strict?: boolean }) => {
      const list = files.length ? files : [".env"];
      const results = list.map((file) => {
        if (!existsSync(file)) throw new Error(`File not found: ${rel(resolve(file))}`);
        const text = readFileSync(file, "utf8");
        const issues = sortIssues(checkEnvText(text));
        let keys: number | null = null;
        let groups: string[] = [];
        try {
          const parsed = parseEnvGroups(text);
          keys = Object.keys(parsed.vars).length;
          groups = [...new Set(Object.values(parsed.groups))].sort();
        } catch {
          // a bad marker: the issues say which line
        }
        return {
          file,
          keys,
          groups,
          errors: issues.filter((i) => i.level === "error").length,
          warnings: issues.filter((i) => i.level === "warning").length,
          issues,
        };
      });
      const errors = results.reduce((n, r) => n + r.errors, 0);
      const warnings = results.reduce((n, r) => n + r.warnings, 0);
      const failed = errors > 0 || (opts.strict === true && warnings > 0);
      if (failed) process.exitCode = 1;

      if (opts.json) return printJson({ ok: !failed, errors, warnings, files: results });
      for (const r of results) {
        for (const i of r.issues) {
          const tag = i.level === "error" ? c.red("error  ") : c.yellow("warning");
          console.log(`${rel(resolve(r.file))}:${i.line}  ${tag}  ${i.message} ${c.dim(`(${i.code})`)}`);
        }
        const detail = r.keys === null ? "" : `${r.keys} key${r.keys === 1 ? "" : "s"}${r.groups.length ? `, groups: ${r.groups.join(", ")}` : ""}`;
        if (!r.issues.length) success(`${rel(resolve(r.file))}: ok${detail ? ` (${detail})` : ""}`);
        else info(c.dim(`${rel(resolve(r.file))}: ${r.errors} error(s), ${r.warnings} warning(s)${detail ? ` · ${detail}` : ""}`));
      }
    });
}
