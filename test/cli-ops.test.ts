import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { describeAccess } from "@envvault/shared";
import { openDb } from "../src/db/index.js";
import type { Database } from "../src/db/schema.js";
import { appRouter } from "../src/rpc/router.js";
import type { Kysely } from "kysely";
import { loadConfig } from "../packages/cli/src/config.js";
import { __setKeyringForTests, persistSession, type Ring } from "../packages/cli/src/keystore.js";
import {
  hubCreateEnv,
  hubCreateProject,
  ensureEnvironment,
  hubGetEnv,
  isDenied,
  hubListEnvironments,
  hubSaveEnv,
  hubSignup,
} from "../packages/cli/src/remote.js";
import {
  hubDeleteEnv,
  hubDeleteProject,
  hubDeleteVersion,
  hubGrantAccess,
  hubHistory,
  hubListAccess,
  hubReadVersion,
  hubRestoreVersion,
  hubRotate,
} from "../packages/cli/src/ops.js";
import { loadTargetAccess, pushTarget, syncTree } from "../packages/cli/src/commands/sync.js";
import { resolveTenantArg } from "../packages/cli/src/cli/helpers.js";
import { parseTreeConfig, resolveTargets } from "../packages/cli/src/tree.js";
import { loadTreeTargets } from "../packages/cli/src/context.js";

const REMOTE = "http://hub.test";
const PASSWORD = "correct horse battery staple";
const SETUP = "cli-ops-setup-token";

let root: string;
let db: Kysely<Database>;
const handler = new RPCHandler(appRouter);
const realFetch = globalThis.fetch;
const dirs: Record<string, string> = {};
const tokens: Record<string, string> = {};
/** Size of the most recent re-key request the CLI sent, in bytes. */
let lastRotateBytes = 0;

function fakeRing(): Ring {
  const store = new Map<string, string>();
  return {
    async get(a) { return store.get(a) ?? null; },
    async set(a, s) { store.set(a, s); },
    async delete(a) { store.delete(a); },
  };
}

/** Act as one of the signed-up users: the CLI reads its session from the config directory. */
function as(name: string) {
  process.env.ENVVAULT_CONFIG_DIR = dirs[name];
  return loadConfig();
}

/** Plain hub client for setup the CLI has no command for (invites, workspaces). */
function raw(token: string): any {
  return createORPCClient(
    new RPCLink({ url: `${REMOTE}/rpc`, headers: () => ({ authorization: `Bearer ${token}` }) }),
  );
}

async function register(name: string, invite: string) {
  dirs[name] = join(root, name);
  process.env.ENVVAULT_CONFIG_DIR = dirs[name];
  await db.deleteFrom("rate_limits").execute();
  const { session } = await hubSignup(loadConfig(), name, PASSWORD, invite);
  await persistSession(REMOTE, session);
  tokens[name] = session.token;
}

describe("CLI environment operations (against an in-process hub)", () => {
  before(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.ENVVAULT_SIGNUP;
    delete process.env.ENVVAULT_TOKEN;
    process.env.ENVVAULT_SETUP_TOKEN = SETUP;
    process.env.ENVVAULT_REMOTE = REMOTE;
    root = mkdtempSync(join(tmpdir(), "envvault-cli-ops-"));
    db = await openDb(join(root, "vault.db"));
    __setKeyringForTests(fakeRing());
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (!request.url.startsWith(`${REMOTE}/rpc`)) return realFetch(input, init);
      if (request.url.endsWith("/environments/rotate")) lastRotateBytes = (await request.clone().text()).length;
      const { response } = await handler.handle(request, {
        prefix: "/rpc",
        context: { headers: request.headers, db },
      });
      return response ?? new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    __setKeyringForTests(undefined);
    delete process.env.ENVVAULT_SETUP_TOKEN;
    delete process.env.ENVVAULT_REMOTE;
    delete process.env.ENVVAULT_CONFIG_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  let orgId: string;
  const target = (user: string, env = "default") => ({ config: as(user), project: "app", env, tenantId: orgId });

  it("creates a workspace project, keeps a history, restores and deletes versions", async () => {
    await register("alice", SETUP);
    const a = raw(tokens.alice!);
    orgId = (await a.tenants.create({ name: "acme" })).id;
    await hubCreateProject(as("alice"), "app", orgId);

    for (const [value, note] of [["1", "first"], ["2", undefined], ["3", undefined]] as const) {
      const cur = await hubGetEnv(as("alice"), "app", "default", orgId);
      await hubSaveEnv(as("alice"), "app", "default", { A: value }, orgId, cur.updatedAt, note);
    }
    const h = await hubHistory(target("alice"));
    assert.equal(h.current.version, 4);
    assert.deepEqual(h.history.map((v) => v.version), [3, 2, 1]);
    assert.equal(h.history.find((v) => v.version === 2)?.note, "first");

    assert.deepEqual((await hubReadVersion(target("alice"), 3)).env, { A: "2" });
    await assert.rejects(hubReadVersion(target("alice"), 99), /No saved version 99.*Saved versions: 3, 2, 1/);

    await hubRestoreVersion(target("alice"), 2);
    assert.deepEqual((await hubGetEnv(as("alice"), "app", "default", orgId)).env, { A: "1" });
    const after = await hubHistory(target("alice"));
    assert.equal(after.current.version, 5);
    assert.equal(after.current.note, "Restored from v2");

    await hubDeleteVersion(target("alice"), 1);
    assert.ok(!(await hubHistory(target("alice"))).history.some((v) => v.version === 1));
  });

  it("creates and deletes environments, but never the last one", async () => {
    await hubCreateEnv(as("alice"), "app", "Staging", orgId);
    const { accessible } = await hubListEnvironments(as("alice"), "app", orgId);
    assert.deepEqual(accessible.map((e) => e.name).sort(), ["default", "staging"]);
    await hubDeleteEnv(target("alice", "staging"));
    await assert.rejects(hubDeleteEnv(target("alice")), /last environment/);
  });

  it("grants permissions separately: write+delete can delete versions but not share or re-key", async () => {
    const invite = await raw(tokens.alice!).admin.invites.create({ expiresInHours: 1 });
    await register("bob", invite.token);
    await raw(tokens.alice!).tenants.invite({ tenantId: orgId, username: "bob", role: "member" });
    await raw(tokens.bob!).tenants.acceptInvite({ tenantId: orgId });

    // A first-time key is asked about, and remembered once trusted.
    let asked = 0;
    const done = await hubGrantAccess(target("alice"), "bob", "write", ["delete"], async (p) => {
      asked++;
      assert.equal(p.status, "new");
      return true;
    });
    assert.equal(done, true);
    assert.equal(asked, 1);

    const entries = await hubListAccess(target("alice"));
    const bob = entries.find((e) => e.username === "bob")!;
    assert.equal(describeAccess(bob.level, bob.caps), "write + delete");

    // bob can read, write and delete versions…
    assert.deepEqual((await hubGetEnv(as("bob"), "app", "default", orgId)).env, { A: "1" });
    await hubSaveEnv(as("bob"), "app", "default", { A: "bob" }, orgId);
    const hb = await hubHistory(target("bob"));
    await hubDeleteVersion(target("bob"), hb.history[hb.history.length - 1]!.version);
    // …but may not share, see who has access, or re-key.
    await assert.rejects(
      hubGrantAccess(target("bob"), "alice", "read", [], async () => true),
      /"share" or "rotate"|"share" permission/,
    );
    await assert.rejects(hubRotate(target("bob")), /"rotate" permission/);

    // Once trusted, the key isn't asked about again (this callback would refuse).
    assert.equal(await hubGrantAccess(target("alice"), "bob", "write", ["delete"], async () => false), true);
  });

  it("revokes by re-keying: the removed user is locked out, history is carried over", async () => {
    const before = await hubHistory(target("alice"));
    const r = await hubRotate(target("alice"), ["bob"]);
    assert.deepEqual(r.kept, ["alice"]);
    assert.deepEqual(r.removed, ["bob"]);
    assert.equal(r.versionsKept, before.history.length);
    assert.equal(r.versionsDropped, 0);

    await assert.rejects(hubGetEnv(as("bob"), "app", "default", orgId), /not available|No access/);
    assert.deepEqual((await hubGetEnv(as("alice"), "app", "default", orgId)).env, { A: "bob" });
    const newest = before.history[0]!;
    assert.ok(await hubReadVersion(target("alice"), newest.version), "history opens under the new key");
    await assert.rejects(hubRotate(target("alice"), ["nobody"]), /doesn't have access/);
  });

  it("re-keying a large history still goes through: the newest versions that fit are kept", async () => {
    await hubCreateEnv(as("alice"), "app", "big", orgId);
    const blob = (n: number) => `${n}`.padEnd(350_000, "x"); // ~470 KB sealed, so 14 saves are ~6.5 MB of history
    for (let i = 1; i <= 14; i++) await hubSaveEnv(as("alice"), "app", "big", { BLOB: blob(i) }, orgId);
    const before = await hubHistory(target("alice", "big"));
    assert.ok(before.history.length >= 12, "a long history to carry over");

    lastRotateBytes = 0;
    const r = await hubRotate(target("alice", "big"));
    const rotateBytes = lastRotateBytes; // the request the client really sent

    assert.ok(rotateBytes > 0 && rotateBytes < 4 * 1024 * 1024, `the request fits the hub's 4 MiB cap (${rotateBytes} bytes)`);
    assert.ok(r.versionsDropped > 0, "some old versions had to be left out");
    assert.ok(r.versionsKept >= 1 && r.versionsKept + r.versionsDropped === before.history.length);

    // the current value reads under the new key, and the newest kept version is the newest one
    assert.equal((await hubGetEnv(as("alice"), "app", "big", orgId)).env.BLOB?.slice(0, 2), "14");
    const after = await hubHistory(target("alice", "big"));
    assert.equal(after.history.length, r.versionsKept);
    assert.equal(after.history[0]!.version, before.history[0]!.version, "newest versions are the ones kept");
    assert.ok(await hubReadVersion(target("alice", "big"), after.history[0]!.version));
    await hubDeleteEnv(target("alice", "big"));
  });

  it("tree sync with partial access: failures are per target, --skip-denied skips, dry-run and list show access", async () => {
    // alice: env `dir3`, and bob gets READ on it only. bob has nothing on `default`.
    await hubCreateEnv(as("alice"), "app", "dir3", orgId);
    await hubSaveEnv(as("alice"), "app", "dir3", { B: "2" }, orgId);
    await hubGrantAccess(target("alice", "dir3"), "bob", "read", [], async () => true);

    const tree = join(root, "tree");
    mkdirSync(join(tree, "dir1"), { recursive: true });
    mkdirSync(join(tree, "dir2/dir3"), { recursive: true });
    writeFileSync(
      join(tree, "envvault.toml"),
      `project = "app"\ntenant = "acme"\n\n[tree.dir1]\nenv = "default"\n\n` +
        `[tree.dir2]\nsync = false\n\n[tree.dir2.children.dir3]\nenv = "dir3"\n`,
    );
    writeFileSync(join(tree, "dir2/dir3/.env"), "LOCAL=1\n");
    writeFileSync(join(tree, "dir1/.env"), "KEEP=me\n");

    const cwd = process.cwd();
    const log = console.log;
    const err = console.error;
    const exit = process.exit;
    /** Run syncTree as `user` from the tree directory, capturing output and the exit code. */
    const run = async (user: string, direction: "pull" | "push", opts: Record<string, unknown>) => {
      const lines: string[] = [];
      let code = 0;
      process.chdir(tree);
      as(user);
      console.log = (...a: unknown[]) => void lines.push(a.join(" "));
      console.error = (...a: unknown[]) => void lines.push(a.join(" "));
      process.exit = ((c?: number) => {
        code = c ?? 0;
        throw new Error("exit");
      }) as typeof process.exit;
      try {
        await syncTree(direction, [], opts);
      } catch (e) {
        if ((e as Error).message !== "exit") throw e;
      } finally {
        console.log = log;
        console.error = err;
        process.exit = exit;
        process.chdir(cwd);
      }
      return { out: lines.join("\n"), code };
    };

    // Without the flag, dir1 fails (clearly) but dir3 still syncs; the run exits 1.
    const plain = await run("bob", "pull", {});
    assert.equal(plain.code, 1);
    assert.match(plain.out, /✗ dir1 .*No access to app\/default.*Environments of "app" you can open: dir3/);
    assert.match(plain.out, /--skip-denied/);
    assert.match(readFileSync(join(tree, "dir2/dir3/.env"), "utf8"), /B=2/);
    assert.equal(readFileSync(join(tree, "dir1/.env"), "utf8"), "KEEP=me\n", "a denied target's file is untouched");

    // With it, dir1 is reported as skipped and the run succeeds.
    const skipped = await run("bob", "pull", { skipDenied: true });
    assert.equal(skipped.code, 0);
    assert.match(skipped.out, /skipped dir1 .*no access/);
    assert.match(skipped.out, /1 synced, 1 skipped/);

    // Read-only: push to dir3 is denied (skipped with the flag, a failure without it).
    writeFileSync(join(tree, "dir2/dir3/.env"), "B=changed\n");
    const pushPlain = await run("bob", "push", {});
    assert.equal(pushPlain.code, 1);
    assert.match(pushPlain.out, /Not allowed to write to app\/dir3/);
    const pushSkip = await run("bob", "push", { skipDenied: true });
    assert.equal(pushSkip.code, 0);
    assert.match(pushSkip.out, /skipped dir2\/dir3 .*read-only/);
    assert.match(pushSkip.out, /skipped dir1 .*no access/);
    assert.match(pushSkip.out, /Nothing was synced/);

    // Dry run checks access without touching anything.
    const dry = await run("bob", "push", { dryRun: true });
    assert.match(dry.out, /dir1.*no access: this would fail/);
    assert.match(dry.out, /dir2\/dir3.*read-only: this would fail/);
    assert.equal(dry.code, 1);
    const dryOk = await run("bob", "pull", { dryRun: true, skipDenied: true });
    assert.match(dryOk.out, /skipped dir1 .*would be skipped/);
    assert.equal(dryOk.code, 0);

    // The access lookup behind `tree list`: none for dir1, read for dir3.
    process.chdir(tree);
    try {
      const loaded = loadTreeTargets(tree)!;
      const map = await loadTargetAccess(as("bob"), loaded.targets);
      const byName = Object.fromEntries(loaded.targets.map((t) => [t.name, map.get(t)]));
      assert.equal(byName["dir1"], null);
      assert.equal((byName["dir2/dir3"] as { level: string }).level, "read");
    } finally {
      process.chdir(cwd);
    }
    assert.ok(existsSync(join(tree, "dir1/.env")));
  });

  it("creates a missing project and environment on push, only when asked; never a workspace", async () => {
    const file = join(root, "create.env");
    writeFileSync(file, "NEW=1\n");
    const alice = as("alice");

    // Without `create`, a project that isn't there is refused (as before).
    await assert.rejects(
      pushTarget(alice, { project: "fresh", env: "default", file, tenantId: orgId }),
      /No access to fresh\/default/,
    );

    // With it, the project (and its default environment) is created, then filled.
    const first = await pushTarget(alice, { project: "fresh", env: "default", file, tenantId: orgId, create: true });
    assert.equal(first.created, "project and environment");
    assert.deepEqual((await hubGetEnv(alice, "fresh", "default", orgId)).env, { NEW: "1" });

    // A second run changes nothing but the data.
    writeFileSync(file, "NEW=2\n");
    const again = await pushTarget(alice, { project: "fresh", env: "default", file, tenantId: orgId, create: true });
    assert.equal(again.created, "");

    // A new environment on an existing project; a new project with a non-default environment.
    const staging = await pushTarget(alice, { project: "fresh", env: "Staging", file, tenantId: orgId, create: true });
    assert.equal(staging.created, "environment");
    const both = await pushTarget(alice, { project: "other", env: "prod", file, tenantId: orgId, create: true });
    assert.equal(both.created, "project and environment");
    assert.deepEqual((await hubGetEnv(alice, "other", "prod", orgId)).env, { NEW: "2" });

    // Something that exists but that you can't open is reported, never overwritten.
    await assert.rejects(
      ensureEnvironment(as("bob"), "app", "default", orgId),
      (e: unknown) => isDenied(e),
    );

    // The workspace must exist: a typo is an error that lists yours, and nothing is created.
    await assert.rejects(resolveTenantArg(as("alice"), "acmee"), /Workspace not found: acmee\. Workspaces you belong to: .*acme/);

    for (const name of ["fresh", "other"]) await hubDeleteProject(as("alice"), name, orgId);
  });

  it("reads `workspace` and `create` from the config, with `tenant` as the older name", () => {
    const text = (extra: string) => `project = "p"\n${extra}\n[tree.a]\n[tree.b]\ncreate = false\nworkspace = "other"\n`;
    const targets = resolveTargets({
      path: "x/envvault.toml",
      dir: "x",
      config: parseTreeConfig(text('workspace = "acme"\ncreate = true'), "toml"),
    });
    assert.deepEqual(targets.map((t) => [t.name, t.tenant, t.create]), [["a", "acme", true], ["b", "other", false]]);
    assert.equal(parseTreeConfig('tenant = "old"\nproject = "p"', "toml").tenant, "old");
    assert.throws(() => parseTreeConfig('tenant = "a"\nworkspace = "b"', "toml"), /"workspace" or "tenant", not both/);
  });

  it("deletes a project", async () => {
    await hubDeleteProject(as("alice"), "app", orgId);
    assert.deepEqual((await raw(tokens.alice!).projects.list({ tenantId: orgId })), []);
  });
});
