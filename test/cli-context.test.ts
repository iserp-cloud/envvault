import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadTreeTargets, requireProject, resolveContext } from "../packages/cli/src/context.js";
import { findTreeFileUp } from "../packages/cli/src/tree.js";
import { wantsWholeTree } from "../packages/cli/src/commands/sync.js";

const TOML = `remote = "http://hub.test"
project = "shop"
env = "dev"

[tree.root]
path = "."

[tree.web]
path = "apps/web"
env = "staging"

[tree.web.children.api]
path = "../api"
project = "shop-api"
tenant = "acme"
file = ".env.local"
`;

let root: string;
let before_cwd: string;
const defaults = { defaultProject: "fallback", defaultEnv: "default" };

describe("CLI config discovery", () => {
  before(() => {
    before_cwd = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "envvault-ctx-")));
    mkdirSync(join(root, "apps/web/src"), { recursive: true });
    mkdirSync(join(root, "apps/api"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "envvault.toml"), TOML);
  });
  after(() => {
    process.chdir(before_cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the nearest config in the current or a parent directory", () => {
    assert.equal(findTreeFileUp(join(root, "apps/web/src")), join(root, "envvault.toml"));
    assert.equal(findTreeFileUp(root), join(root, "envvault.toml"));
  });

  it("uses the target whose directory contains where you are", () => {
    const web = resolveContext({}, defaults, join(root, "apps/web/src"));
    assert.equal(web.project, "shop");
    assert.equal(web.env, "staging");
    assert.equal(web.source?.target, "web");
    assert.equal(web.file, join(root, "apps/web/.env"));

    const api = resolveContext({}, defaults, join(root, "apps/api"));
    assert.equal(api.project, "shop-api");
    assert.equal(api.tenant, "acme");
    assert.equal(api.file, join(root, "apps/api/.env.local"));
  });

  it("falls back to the root settings outside every target, then to saved defaults", () => {
    const docs = resolveContext({}, defaults, join(root, "docs"));
    assert.equal(docs.project, "shop");
    assert.equal(docs.env, "dev");
    assert.equal(docs.file, join(root, ".env"));

    const none = mkdtempSync(join(tmpdir(), "envvault-none-"));
    try {
      const bare = resolveContext({}, defaults, none);
      assert.equal(bare.project, "fallback");
      assert.equal(bare.env, "default");
      assert.equal(bare.source, undefined);
      assert.equal(bare.file, join(none, ".env"));
    } finally {
      rmSync(none, { recursive: true, force: true });
    }
  });

  it("lets command-line flags win, and says how to set a missing project", () => {
    const ctx = resolveContext(
      { project: "other", env: "PROD", tenant: "me", file: "x.env" },
      defaults,
      join(root, "apps/web"),
    );
    assert.equal(ctx.project, "other");
    assert.equal(ctx.env, "prod", "environment names are normalised");
    assert.equal(ctx.tenant, "me");
    assert.equal(ctx.file, join(root, "apps/web/x.env"));
    assert.throws(() => requireProject({ env: "default", file: "", merge: false }), /No project chosen/);
  });

  it("reads envvault.json too, and refuses two config files in one directory", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "envvault-json-")));
    try {
      writeFileSync(join(dir, "envvault.json"), JSON.stringify({ project: "j", env: "qa" }));
      const ctx = resolveContext({}, {}, dir);
      assert.equal(ctx.project, "j");
      assert.equal(ctx.env, "qa");
      writeFileSync(join(dir, "envvault.toml"), 'project = "t"\n');
      assert.throws(() => resolveContext({}, {}, dir) && loadTreeTargets(dir), /Multiple config files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncs the whole tree only from the config's own directory, unless told otherwise", () => {
    process.chdir(root);
    assert.equal(wantsWholeTree(false, false), true);
    assert.equal(wantsWholeTree(true, false), false, "a flag narrows it");
    process.chdir(join(root, "apps/web"));
    assert.equal(wantsWholeTree(false, false), false, "inside a target: just that target");
    assert.equal(wantsWholeTree(false, true), true, "--all from anywhere below");
  });
});
