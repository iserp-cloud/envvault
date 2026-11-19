import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import {
  createAccountMaterial,
  deriveFromPassword,
  envAad,
  generateDek,
  generateIdentityKeyPair,
  sealEnv,
  unwrapSecretWithPrivateKey,
  wrapSecretForPublicKey,
} from "@envvault/shared";
import type { Kysely } from "kysely";
import { pepperPolicy } from "../src/auth-proof.js";
import { openDb } from "../src/db/index.js";
import type { Database } from "../src/db/schema.js";
import { appRouter } from "../src/rpc/router.js";
import { writeSecretFile } from "../packages/cli/src/cli/helpers.js";


/** Share an environment the way a client does: with the key generation it just loaded. */
async function grantAccess(api: any, input: any) {
  const rows = await api.environments.list({ tenantId: input.tenantId, project: input.project }).catch(() => []);
  const keyVersion = rows.find((e: any) => e.name === input.name)?.keyVersion ?? 1;
  return api.environments.grantAccess({ keyVersion, ...input });
}

type Api = any;
const PASSWORD = "correct horse battery staple";
const SETUP = "review-setup-token";
let dir: string;
let db: Kysely<Database>;
const handler = new RPCHandler(appRouter);

function client(token?: string, ip = "10.0.0.1"): Api {
  return createORPCClient(
    new RPCLink({
      url: "http://hub.test/rpc",
      headers: () => (token ? { authorization: `Bearer ${token}` } : {}),
      fetch: async (request: Request) => {
        const { response } = await handler.handle(request, {
          prefix: "/rpc",
          context: { headers: request.headers, db, remoteAddress: ip },
        });
        return response ?? new Response("nf", { status: 404 });
      },
    }),
  );
}

type User = { username: string; token: string; privateKey: string; publicKey: string; api: Api };

async function signup(username: string, inviteToken?: string): Promise<User> {
  const m = await createAccountMaterial(username, PASSWORD);
  const r = await client().signup({
    username, authKey: m.authKey, kdf: m.kdf, publicKey: m.publicKey,
    wrappedPrivateKey: m.wrappedPrivateKey,
    recovery: { authKey: m.recovery.recoveryAuthKey, wrappedPrivateKey: m.recovery.recoveryWrappedPrivateKey },
    inviteToken,
  });
  return { username, token: r.token, privateKey: m.privateKey, publicKey: m.publicKey, api: client(r.token) };
}

async function rawLogin(username: string, password = PASSWORD, ip = "10.0.0.1") {
  const c = client(undefined, ip);
  const { kdf } = await c.prelogin({ username });
  const keys = await deriveFromPassword(password, username, kdf);
  return c.login({ username, authKey: keys.authKey });
}

async function makeProject(u: User, tenantId: string, name: string) {
  const dek = generateDek();
  const recipients = await u.api.tenants.keyRecipients({ tenantId });
  await u.api.projects.create({
    tenantId, name,
    payload: await sealEnv({ K: "v" }, dek, envAad(tenantId, name, "default")),
    keyWraps: await Promise.all(recipients.map(async (r: any) => ({
      username: r.username, wrappedEnvDek: await wrapSecretForPublicKey(dek, r.publicKey),
    }))),
  });
  return dek;
}

async function grant(by: User, tenantId: string, project: string, to: string, level: "read" | "write" | "manage", dek: string) {
  const { publicKey } = await by.api.users.resolve({ username: to });
  await grantAccess(by.api, {
    tenantId, project, name: "default", username: to, level,
    wrappedEnvDek: await wrapSecretForPublicKey(dek, publicKey),
  });
}

describe("review fixes", () => {
  let alice: User;
  let bob: User;
  let carol: User;
  let orgId: string;
  let dek: string;

  before(async () => {
    for (const k of ["ENVVAULT_SIGNUP", "ENVVAULT_ALLOW_SIGNUP", "ENVVAULT_SETUP_TOKEN", "ENVVAULT_PEPPER", "ENVVAULT_ALLOW_NO_PEPPER"]) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "envvault-review-"));
    db = await openDb(process.env.TEST_DATABASE_URL ?? join(dir, "vault.db"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("fails closed: the first account can't be created when no setup token is configured", async () => {
    assert.equal((await client().status()).requiresSetupToken, true);
    await assert.rejects(signup("alice"), /no setup token configured/i);
    await assert.rejects(signup("alice", "guess-guess-guess"), /no setup token configured/i);
    process.env.ENVVAULT_SETUP_TOKEN = SETUP;
    await assert.rejects(signup("alice", "wrong-token"), /valid setup token/i);
    alice = await signup("alice", SETUP);
    assert.equal((await alice.api.me()).role, "admin");
  });

  it("set up a workspace with a manager, an active member and a pending invitee", async () => {
    const org = await alice.api.tenants.create({ name: "acme" });
    orgId = org.id;
    const invites = await Promise.all(["bob", "carol"].map((n) => alice.api.admin.invites.create({ expiresInHours: 1, tenantId: orgId, note: n })));
    bob = await signup("bob", invites[0].token);
    carol = await signup("carol", invites[1].token);
    await bob.api.tenants.acceptInvite({ tenantId: orgId });
    // carol stays PENDING
    dek = await makeProject(alice, orgId, "api");
    await grant(alice, orgId, "api", "bob", "manage", dek);
    assert.equal((await alice.api.tenants.members({ tenantId: orgId })).find((m: any) => m.username === "carol").status, "pending");
  });

  it("a manager can't overwrite or demote the workspace owner's access", async () => {
    // bob (manager) tries to replace alice's key and level
    await assert.rejects(grant(bob, orgId, "api", "alice", "read", generateDek()), /owner's access can't be changed/);
    // alice can still read her environment
    const list = await alice.api.environments.list({ tenantId: orgId, project: "api" });
    assert.equal(list[0].level, "manage");
    assert.equal(await unwrapSecretWithPrivateKey(list[0].wrappedEnvDek, alice.privateKey), dek);
  });

  it("creating an environment can only key the owner, admins and the creator", async () => {
    const newDek = generateDek();
    const wrap = async (u: string, pk: string) => ({ username: u, wrappedEnvDek: await wrapSecretForPublicKey(newDek, pk) });
    const payload = await sealEnv({}, newDek, envAad(orgId, "api", "staging"));
    // bob invites a plain member into a brand-new environment as manager — refused
    const members = await alice.api.tenants.keyRecipients({ tenantId: orgId });
    const alicePk = members.find((m: any) => m.username === "alice").publicKey;
    const bobPk = bob.publicKey;
    await assert.rejects(
      bob.api.environments.create({
        tenantId: orgId, project: "api", name: "staging", payload,
        keyWraps: [await wrap("alice", alicePk), await wrap("bob", bobPk), await wrap("carol", carol.publicKey)],
      }),
      /keyWraps may only include|must be an active/,
    );
    // The legitimate shape works.
    await bob.api.environments.create({
      tenantId: orgId, project: "api", name: "staging", payload,
      keyWraps: [await wrap("alice", alicePk), await wrap("bob", bobPk)],
    });
  });

  it("a pending invitee who was granted manage can't delete the project", async () => {
    await grant(alice, orgId, "api", "carol", "manage", dek); // allowed: grant-before-accept is a feature
    await assert.rejects(carol.api.projects.delete({ tenantId: orgId, name: "api" }), /Not a member/);
    assert.equal((await alice.api.projects.list({ tenantId: orgId })).length, 1, "project still exists");
  });

  it("deleting a workspace disables its service accounts and signs them out", async () => {
    const keys = await generateIdentityKeyPair();
    const svc = await alice.api.serviceAccounts.create({ tenantId: orgId, name: "ci", publicKey: keys.publicKey });
    const svcApi = client(svc.token);
    assert.equal((await svcApi.me()).kind, "service");

    await alice.api.tenants.delete({ tenantId: orgId });
    await assert.rejects(svcApi.me(), /Invalid auth token/, "token stops working");
    const row = await db.selectFrom("users").selectAll().where("username", "=", "svc-ci").executeTakeFirstOrThrow();
    assert.equal(row.status, "disabled");
    assert.equal((await db.selectFrom("tenants").selectAll().where("id", "=", orgId).execute()).length, 0);
  });

  it("two admins can't disable each other at the same time", async () => {
    await alice.api.admin.users.setRole({ username: "bob", role: "admin" });
    const a = client((await rawLogin("alice", PASSWORD, "10.9.0.1")).token);
    const b = client((await rawLogin("bob", PASSWORD, "10.9.0.2")).token);
    const results = await Promise.allSettled([
      a.admin.users.setStatus({ username: "bob", status: "disabled" }),
      b.admin.users.setStatus({ username: "alice", status: "disabled" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 1, "exactly one succeeds");
    const admins = await db.selectFrom("users").selectAll().where("role", "=", "admin").where("status", "=", "active").execute();
    assert.equal(admins.length, 1, "an active administrator always remains");
    // restore both for the following tests
    await db.updateTable("users").set({ status: "active" }).execute();
  });

  it("prelogin doesn't reveal which usernames exist", async () => {
    // Give bob different KDF settings, as if upgraded later.
    const variant = { alg: "argon2id", m: 32768, t: 4, p: 1 };
    await db.updateTable("users").set({ kdf: JSON.stringify(variant) }).where("username", "=", "bob").execute();
    const defaults = JSON.parse((await db.selectFrom("users").select("kdf").where("username", "=", "alice").executeTakeFirstOrThrow()).kdf);

    const c = client();
    const known = [JSON.stringify(variant), JSON.stringify(defaults)];
    const seen = new Set<string>();
    for (const name of ["nobody", "ghost", "zed", "mallory", "trent", "oscar", "peggy", "victor", "walter", "eve"]) {
      const first = (await c.prelogin({ username: name })).kdf;
      assert.deepEqual((await c.prelogin({ username: name })).kdf, first, "deterministic per name");
      assert.ok(known.includes(JSON.stringify(first)), "drawn from parameter sets actually in use");
      seen.add(JSON.stringify(first));
    }
    assert.equal(seen.size, 2, "unknown names look like both kinds of real account");
    assert.deepEqual((await c.prelogin({ username: "bob" })).kdf, variant, "real accounts still get their own settings");
    await db.updateTable("users").set({ kdf: JSON.stringify(defaults) }).where("username", "=", "bob").execute();
  });

  it("per-account lockout can't be used to lock the owner out from their usual address", async () => {
    await db.deleteFrom("rate_limits").execute();
    const home = "10.20.30.40";
    await rawLogin("alice", PASSWORD, home); // establishes a known address (audited)

    // An attacker spreads wrong guesses over many addresses until the account is throttled.
    let blockedStranger = false;
    for (let i = 0; i < 16; i++) {
      try { await rawLogin("alice", "wrong password!!", `66.6.6.${i}`); } catch (e: any) {
        if (/Too many/.test(e.message)) { blockedStranger = true; break; }
      }
    }
    assert.ok(blockedStranger, "strangers are throttled");
    await assert.rejects(rawLogin("alice", PASSWORD, "77.7.7.7"), /Too many/, "an unfamiliar address stays blocked");
    assert.ok((await rawLogin("alice", PASSWORD, home)).token, "the owner's usual address still gets in");
  });

  it("refuses to run without a pepper in strict mode", () => {
    delete process.env.ENVVAULT_PEPPER;
    assert.equal(pepperPolicy(true), "refuse");
    assert.equal(pepperPolicy(false), "warn");
    process.env.ENVVAULT_ALLOW_NO_PEPPER = "true";
    assert.equal(pepperPolicy(true), "warn", "explicit opt-out");
    delete process.env.ENVVAULT_ALLOW_NO_PEPPER;
    process.env.ENVVAULT_PEPPER = "x".repeat(32);
    assert.equal(pepperPolicy(true), "ok");
    delete process.env.ENVVAULT_PEPPER;
  });

  it("CLI tightens permissions on an existing world-readable file", { skip: process.platform === "win32" }, () => {
    const f = join(dir, ".env");
    writeFileSync(f, "OLD=1\n");
    chmodSync(f, 0o644);
    assert.equal(statSync(f).mode & 0o777, 0o644);
    writeSecretFile(f, "SECRET=1\n");
    assert.equal(statSync(f).mode & 0o777, 0o600);
  });
});
