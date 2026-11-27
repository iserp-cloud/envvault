import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { checkEnvText, sortIssues } from "@envvault/shared";
import { registerAgent } from "../packages/cli/src/commands/agent.js";
import { AGENTS_END, AGENTS_START, skillText, withAgentsBlock } from "../packages/cli/src/skill.js";

const codes = (text: string) => checkEnvText(text).map((i) => `${i.line}:${i.code}`);

describe("envvault check: the .env validator", () => {
  it("a clean file, with comments, quotes and groups, has no issues", () => {
    assert.deepEqual(checkEnvText('# comment\nA=1\nB="two words"\n\n# @group db\nDB_URL=postgres://x\n'), []);
  });

  it("flags the things push would drop or change, by line", () => {
    assert.deepEqual(codes("A=1\nnot a pair\nexport B=2\n1BAD=x\nC=\"open\nD=value # note\n"), [
      "2:not-key-value",
      "3:export-prefix",
      "4:key-invalid",
      "5:unterminated-quote",
      "6:inline-comment",
    ]);
  });

  it("flags bad group markers and keeps checking the rest of the file", () => {
    assert.deepEqual(codes("# @group\nA=1\n# @group Bad Name\nB=2\n# @group db\nC=3\n"), [
      "1:group-name-missing",
      "3:group-name-invalid",
    ]);
  });

  it("warns about duplicates (and a changed group), empty values and lower-case keys", () => {
    const issues = checkEnvText("A=1\n# @group db\nA=2\nlower=x\nE=\n");
    assert.deepEqual(issues.map((i) => `${i.level}:${i.code}`), [
      "warning:duplicate-key",
      "warning:key-not-uppercase",
      "warning:empty-value",
    ]);
    assert.match(issues[0]!.message, /group becomes db/);
  });

  it("warns when a sensitive-looking key is in a group that reads like plain settings", () => {
    assert.deepEqual(codes("# @group config\nAPI_KEY=x\nLOG=info\n# @group db\nDB_PASSWORD=x\n"), ["2:sensitive-in-config-group"]);
  });

  it("errors come before warnings", () => {
    const sorted = sortIssues(checkEnvText("lower=x\nnot a pair\n"));
    assert.deepEqual(sorted.map((i) => i.level), ["error", "warning"]);
  });
});

describe("envvault skill", () => {
  let dir: string;
  let out: string[];
  const realLog = console.log;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ev-agent-"));
    out = [];
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    process.exitCode = undefined;
  });
  afterEach(() => {
    console.log = realLog;
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride();
    registerAgent(program);
    await program.parseAsync(["node", "envvault", ...args]);
  };

  it("the skill has the front matter agents need and the rules that matter", () => {
    const text = skillText("9.9.9");
    assert.match(text, /^---\nname: envvault\ndescription: /);
    assert.match(text, /CLI 9\.9\.9/);
    assert.ok(!text.includes("{{version}}"));
    for (const must of ["# @group", "--no-groups", "envvault check", "REPLACES the whole environment", "Never print"]) {
      assert.ok(text.includes(must), must);
    }
  });

  it("install writes the Claude skill and an AGENTS.md block, and is idempotent", async () => {
    await run("skill", "install", "-d", dir);
    const skill = join(dir, ".claude", "skills", "envvault", "SKILL.md");
    assert.match(readFileSync(skill, "utf8"), /^---\nname: envvault/);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(agents.includes(AGENTS_START) && agents.includes(AGENTS_END));
    await run("skill", "install", "-d", dir);
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), agents);
    assert.ok(out.some((l) => /Up to date/.test(l)));
  });

  it("install only touches its own block in an existing AGENTS.md", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# My rules\n\nBe nice.\n");
    await run("skill", "install", "-d", dir, "--target", "agents");
    assert.ok(!existsSync(join(dir, ".claude")));
    let text = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(text.startsWith("# My rules\n\nBe nice.\n"));
    // a stale block is replaced in place, text on both sides kept
    text = text.replace("Run `envvault skill`", "OLD TEXT").replace(/$/, "\nTrailing notes.\n");
    writeFileSync(join(dir, "AGENTS.md"), text);
    await run("skill", "install", "-d", dir, "--target", "agents");
    const after = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(!after.includes("OLD TEXT") && after.includes("Trailing notes.") && after.startsWith("# My rules"));
    assert.equal(after.split(AGENTS_START).length, 2, "one block only");
    assert.equal(withAgentsBlock(null).trim().startsWith(AGENTS_START), true);
  });

  it("install refuses nonsense targets", async () => {
    await assert.rejects(run("skill", "install", "-d", dir, "--target", "x"), /--target/);
    await assert.rejects(run("skill", "install", "-d", dir, "--global", "--target", "agents"), /--global/);
  });

  it("check exits 1 on errors (and with --strict on warnings), and --json says why", async () => {
    mkdirSync(join(dir, "x"));
    const bad = join(dir, "bad.env");
    const warn = join(dir, "warn.env");
    const good = join(dir, "good.env");
    writeFileSync(bad, "A=1\n# @group Nope Nope\nB=2\n");
    writeFileSync(warn, "lower=1\n");
    writeFileSync(good, "A=1\n# @group db\nB=2\n");

    await run("check", good);
    assert.equal(process.exitCode, undefined);
    await run("check", warn);
    assert.equal(process.exitCode, undefined);
    await run("check", warn, "--strict");
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;

    out.length = 0;
    await run("check", bad, good, "--json");
    assert.equal(process.exitCode, 1);
    const report = JSON.parse(out.join("\n"));
    assert.equal(report.ok, false);
    assert.equal(report.errors, 1);
    assert.equal(report.files[0].issues[0].code, "group-name-invalid");
    assert.equal(report.files[0].issues[0].line, 2);
    assert.deepEqual([report.files[1].keys, report.files[1].groups], [2, ["db"]]);
    await assert.rejects(run("check", join(dir, "missing.env")), /File not found/);
  });
});
