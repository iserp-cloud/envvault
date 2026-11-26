import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import {
  DEFAULT_KDF,
  createAccountMaterial,
  decodeServiceToken,
  deriveFromPassword,
  deriveRecoveryKeys,
  encodeServiceToken,
  generateIdentityKeyPair,
  openRecoveredPrivateKey,
  seal,
  privateKeyAad,
  envAad,
  generateDek,
  openEnv,
  openPrivateKey,
  sealEnv,
  unwrapSecretWithPrivateKey,
  wrapSecretForPublicKey,
  type SealedBox,
} from "@envvault/shared";
import { openDb } from "../src/db/index.js";
import type { Database } from "../src/db/schema.js";
import { appRouter } from "../src/rpc/router.js";
import type { Kysely } from "kysely";


/** Share an environment the way a client does: with the key generation it just loaded. */
async function grantAccess(api: any, input: any) {
  const rows = await api.environments.list({ tenantId: input.tenantId, project: input.project }).catch(() => []);
  const keyVersion = rows.find((e: any) => e.name === input.name)?.keyVersion ?? 1;
  return api.environments.grantAccess({ keyVersion, ...input });
}

type Api = any;

let dir: string;
let db: Kysely<Database>;
const handler = new RPCHandler(appRouter);

function client(token?: string): Api {
  const link = new RPCLink({
    url: "http://hub.test/rpc",
    headers: () => (token ? { authorization: `Bearer ${token}` } : {}),
    fetch: async (request: Request) => {
      const { response } = await handler.handle(request, {
        prefix: "/rpc",
        context: { headers: request.headers, db },
      });
      return response ?? new Response("not found", { status: 404 });
    },
  });
  return createORPCClient(link);
}

type User = { username: string; token: string; privateKey: string; publicKey: string; api: Api; recoveryKey?: string };

const PASSWORD = "correct horse battery staple";

function recoveryOf(m: Awaited<ReturnType<typeof createAccountMaterial>>) {
  return { authKey: m.recovery.recoveryAuthKey, wrappedPrivateKey: m.recovery.recoveryWrappedPrivateKey };
}

async function signup(username: string, inviteToken?: string): Promise<User> {
  const m = await createAccountMaterial(username, PASSWORD);
  const r = await client().signup({
    username,
    authKey: m.authKey,
    kdf: m.kdf,
    publicKey: m.publicKey,
    wrappedPrivateKey: m.wrappedPrivateKey,
    recovery: recoveryOf(m),
    inviteToken,
  });
  return {
    username, token: r.token, privateKey: m.privateKey, publicKey: m.publicKey,
    api: client(r.token), recoveryKey: m.recovery.recoveryKey,
  };
}

async function login(username: string, password = PASSWORD): Promise<User> {
  const { kdf } = await client().prelogin({ username });
  const keys = await deriveFromPassword(password, username, kdf);
  const r = await client().login({ username, authKey: keys.authKey });
  const privateKey = await openPrivateKey(r.wrappedPrivateKey as SealedBox, keys.wrapKey, username);
  return { username, token: r.token, privateKey, publicKey: r.publicKey, api: client(r.token) };
}

/** Create a project the way the dashboard does and return its DEK. */
async function makeProject(u: User, tenantId: string, name: string, env: Record<string, string>) {
  const dek = generateDek();
  const recipients = await u.api.tenants.keyRecipients({ tenantId });
  const keyWraps = await Promise.all(
    recipients.map(async (r: any) => ({
      username: r.username,
      wrappedEnvDek: await wrapSecretForPublicKey(dek, r.publicKey),
    })),
  );
  const payload = await sealEnv(env, dek, envAad(tenantId, name, "default"));
  await u.api.projects.create({ tenantId, name, payload, keyWraps });
  return dek;
}

async function readEnv(u: User, tenantId: string, project: string, name = "default") {
  const list = await u.api.environments.list({ tenantId, project });
  const meta = list.find((e: any) => e.name === name);
  assert.ok(meta, "environment visible");
  const dek = await unwrapSecretWithPrivateKey(meta.wrappedEnvDek, u.privateKey);
  const got = await u.api.environments.getEnv({ tenantId, project, name });
  return openEnv(got.payload, dek, envAad(tenantId, project, name));
}

describe("zero-knowledge hub", () => {
  let admin: User;
  let bob: User;
  /** bob is promoted to admin mid-suite; use his latest session for admin calls. */
  let bobAdmin: User;
  const admin2 = () => bobAdmin;

  before(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.ENVVAULT_SIGNUP;
    delete process.env.ENVVAULT_ALLOW_SIGNUP;
    process.env.ENVVAULT_SETUP_TOKEN = "test-setup-token"; // first signup fails closed without one
    dir = mkdtempSync(join(tmpdir(), "envvault-test-"));
    db = await openDb(join(dir, "vault.db"));
  });

  after(() => {
    delete process.env.ENVVAULT_SETUP_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });

  it("first account becomes the administrator", async () => {
    assert.equal((await client().status()).initialized, false);
    admin = await signup("alice", "test-setup-token");
    assert.equal((await admin.api.me()).role, "admin");
  });

  it("never stores or receives the password", async () => {
    const row = await db.selectFrom("users").selectAll().where("username", "=", "alice").executeTakeFirstOrThrow();
    assert.ok(!JSON.stringify(row).includes(PASSWORD));
    assert.ok(!("password_hash" in row));
  });

  it("rejects a wrong password and unknown users identically", async () => {
    await assert.rejects(login("alice", "wrong password!!"), /Invalid username or password/);
    await assert.rejects(login("nobody"), /Invalid username or password/);
  });

  it("login returns a private key only the password can open", async () => {
    const again = await login("alice");
    assert.equal(again.privateKey, admin.privateKey);
  });

  it("correct sign-ins don't use up the attempt limit (every unlock is a sign-in)", async () => {
    await db.deleteFrom("rate_limits").execute();
    for (let i = 0; i < 12; i++) await login("alice"); // more than the 8 allowed guesses per address and account
    await db.deleteFrom("rate_limits").execute();
    for (let i = 0; i < 8; i++) await assert.rejects(login("alice", "wrong password!!"), /Invalid username or password/);
    await assert.rejects(login("alice", "wrong password!!"), /Too many attempts/); // guesses still run out
    await db.deleteFrom("rate_limits").execute();
  });

  it("stores only ciphertext", async () => {
    const tid = "p_alice";
    await makeProject(admin, tid, "billing", { STRIPE_KEY: "sk_live_TOPSECRET" });
    const rows = await db.selectFrom("environments").selectAll().execute();
    const dump = JSON.stringify(rows) + JSON.stringify(await db.selectFrom("environment_keys").selectAll().execute());
    assert.ok(!dump.includes("TOPSECRET") && !dump.includes("STRIPE_KEY"));
    assert.deepEqual(await readEnv(admin, tid, "billing"), { STRIPE_KEY: "sk_live_TOPSECRET" });
  });

  it("save round-trips and detects concurrent edits", async () => {
    const tid = "p_alice";
    const list = await admin.api.environments.list({ tenantId: tid, project: "billing" });
    const dek = await unwrapSecretWithPrivateKey(list[0].wrappedEnvDek, admin.privateKey);
    const first = await admin.api.environments.getEnv({ tenantId: tid, project: "billing", name: "default" });
    const payload = await sealEnv({ A: "1", MULTI: "line1\nline2 \"quoted\"" }, dek, envAad(tid, "billing", "default"));
    await admin.api.environments.saveEnv({ tenantId: tid, project: "billing", name: "default", payload, baseUpdatedAt: first.updatedAt });
    assert.deepEqual(await readEnv(admin, tid, "billing"), { A: "1", MULTI: "line1\nline2 \"quoted\"" });
    await assert.rejects(
      admin.api.environments.saveEnv({ tenantId: tid, project: "billing", name: "default", payload, baseUpdatedAt: first.updatedAt }),
      /changed by someone else/,
    );
  });

  it("binds ciphertext to its location (no swapping between environments)", async () => {
    const tid = "p_alice";
    await makeProject(admin, tid, "other", { X: "y" });
    const a = await admin.api.environments.getEnv({ tenantId: tid, project: "billing", name: "default" });
    const list = await admin.api.environments.list({ tenantId: tid, project: "other" });
    const dekOther = await unwrapSecretWithPrivateKey(list[0].wrappedEnvDek, admin.privateKey);
    await assert.rejects(openEnv(a.payload, dekOther, envAad(tid, "other", "default")));
    const listB = await admin.api.environments.list({ tenantId: tid, project: "billing" });
    const dekB = await unwrapSecretWithPrivateKey(listB[0].wrappedEnvDek, admin.privateKey);
    await assert.rejects(openEnv(a.payload, dekB, envAad(tid, "other", "default")));
  });

  it("requires an invite once the first account exists", async () => {
    await assert.rejects(signup("mallory"), /invite is required/i);
    await assert.rejects(signup("mallory", "not-a-real-invite-token"), /Invalid or expired invite/);
  });

  it("only admins can manage invites; invites are single-use and revocable", async () => {
    const org = await admin.api.tenants.create({ name: "acme" });
    const inv = await admin.api.admin.invites.create({ expiresInHours: 24, note: "bob", tenantId: org.id, tenantRole: "member" });
    const raw = JSON.stringify(await db.selectFrom("invites").selectAll().execute());
    assert.ok(!raw.includes(inv.token), "only a hash of the token is stored");

    bob = await signup("bob", inv.token);
    assert.equal((await bob.api.me()).role, "member");
    await assert.rejects(signup("carol", inv.token), /Invalid or expired invite/);
    await assert.rejects(bob.api.admin.users.list(), /Administrator access required/);
    await assert.rejects(bob.api.admin.invites.create({}), /Administrator access required/);

    const pending = await bob.api.tenants.invites();
    assert.equal(pending[0]?.slug, "acme");
    await bob.api.tenants.acceptInvite({ tenantId: org.id });

    const inv2 = await admin.api.admin.invites.create({ expiresInHours: 1 });
    await admin.api.admin.invites.revoke({ id: inv2.id });
    await assert.rejects(signup("dave", inv2.token), /Invalid or expired invite/);
    const states = (await admin.api.admin.invites.list()).map((i: any) => i.state).sort();
    assert.deepEqual(states, ["revoked", "used"]);
  });

  it("shares a DEK with a member, then rotation locks out a revoked member", async () => {
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const tid = org.id;
    const oldDek = await makeProject(admin, tid, "api", { DB_URL: "postgres://prod" });

    // grant bob (wrap DEK for his public key)
    const resolved = await admin.api.users.resolve({ username: "bob" });
    await grantAccess(admin.api, {
      tenantId: tid, project: "api", name: "default", username: "bob", level: "read",
      wrappedEnvDek: await wrapSecretForPublicKey(oldDek, resolved.publicKey),
    });
    assert.deepEqual(await readEnv(bob, tid, "api"), { DB_URL: "postgres://prod" });
    await assert.rejects(
      bob.api.environments.saveEnv({ tenantId: tid, project: "api", name: "default", payload: (await admin.api.environments.getEnv({ tenantId: tid, project: "api", name: "default" })).payload }),
      /Requires write access/,
    );

    // rotate to a fresh DEK, excluding bob
    const newDek = generateDek();
    const payload = await sealEnv({ DB_URL: "postgres://prod" }, newDek, envAad(tid, "api", "default"));
    await admin.api.environments.rotate({
      tenantId: tid, project: "api", name: "default", payload,
      keyWraps: [{ username: "alice", wrappedEnvDek: await wrapSecretForPublicKey(newDek, admin.publicKey) }],
    });
    await assert.rejects(readEnv(bob, tid, "api"), /visible|No access/);
    await assert.rejects(
      bob.api.environments.getEnv({ tenantId: tid, project: "api", name: "default" }),
      /No access/,
    );
    // even with the old DEK he kept, the new ciphertext is unreadable
    const current = await admin.api.environments.getEnv({ tenantId: tid, project: "api", name: "default" });
    await assert.rejects(openEnv(current.payload, oldDek, envAad(tid, "api", "default")));
    assert.deepEqual(await readEnv(admin, tid, "api"), { DB_URL: "postgres://prod" });
  });

  it("a grant made from a key that was rotated meanwhile is refused", async () => {
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const tid = org.id;
    const loc = { tenantId: tid, project: "stale-key", name: "default" };
    const dek = await makeProject(admin, tid, "stale-key", { A: "1" });

    // the sharer loads the environment's key (and its generation)...
    const before = (await admin.api.environments.list({ tenantId: tid, project: "stale-key" }))[0];
    assert.equal(before.keyVersion, 1);
    const bobKey = await admin.api.users.resolve({ username: "bob" });
    const staleGrant = {
      ...loc, username: "bob", level: "read" as const,
      wrappedEnvDek: await wrapSecretForPublicKey(dek, bobKey.publicKey), keyVersion: before.keyVersion,
    };

    // ...then someone rotates the key before the grant arrives
    const newDek = generateDek();
    await admin.api.environments.rotate({
      ...loc, payload: await sealEnv({ A: "1" }, newDek, envAad(tid, "stale-key", "default")),
      keyWraps: [{ username: "alice", wrappedEnvDek: await wrapSecretForPublicKey(newDek, admin.publicKey) }],
    });
    const after = (await admin.api.environments.list({ tenantId: tid, project: "stale-key" }))[0];
    assert.equal(after.keyVersion, 2, "a rotation starts a new key generation");

    await assert.rejects(admin.api.environments.grantAccess(staleGrant), /key was rotated/);
    await assert.rejects(readEnv(bob, tid, "stale-key"), /No access|visible/, "nothing was granted");
    await assert.rejects(
      admin.api.environments.grantAccess({ ...staleGrant, keyVersion: undefined } as never),
      "the generation is required",
    );

    // sharing again from the current key works, and bob can read the current secrets
    await admin.api.environments.grantAccess({
      ...staleGrant, wrappedEnvDek: await wrapSecretForPublicKey(newDek, bobKey.publicKey), keyVersion: after.keyVersion,
    });
    assert.deepEqual(await readEnv(bob, tid, "stale-key"), { A: "1" });
  });

  it("cannot rotate away the tenant owner, or add users that were never granted", async () => {
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const dek = generateDek();
    const payload = await sealEnv({}, dek, envAad(org.id, "api", "default"));
    await assert.rejects(
      admin.api.environments.rotate({
        tenantId: org.id, project: "api", name: "default", payload,
        keyWraps: [{ username: "bob", wrappedEnvDek: "x" }],
      }),
      /must include you|no access/,
    );
    await assert.rejects(
      admin.api.environments.rotate({
        tenantId: org.id, project: "api", name: "default", payload,
        keyWraps: [
          { username: "alice", wrappedEnvDek: await wrapSecretForPublicKey(dek, admin.publicKey) },
          { username: "bob", wrappedEnvDek: "x" },
        ],
      }),
      /grant it first/,
    );
  });

  it("disabling a user signs them out and blocks login; last admin is protected", async () => {
    const stillIn = bob.api;
    await admin.api.admin.users.setStatus({ username: "bob", status: "disabled" });
    await assert.rejects(stillIn.me(), /Invalid auth token/);
    await assert.rejects(login("bob"), /disabled/);
    await admin.api.admin.users.setStatus({ username: "bob", status: "active" });
    assert.equal((await login("bob")).username, "bob");

    await assert.rejects(admin.api.admin.users.setStatus({ username: "alice", status: "disabled" }), /At least one active administrator/);
    await assert.rejects(admin.api.admin.users.setRole({ username: "alice", role: "member" }), /At least one active administrator/);
    await admin.api.admin.users.setRole({ username: "bob", role: "admin" });
    await admin.api.admin.users.setRole({ username: "alice", role: "member" });
  });

  it("changing the password re-seals the key and invalidates old sessions", async () => {
    bob = await login("bob"); // earlier test revoked his original session
    const oldSession = bob.api;
    const { authKey: current } = await deriveFromPassword(PASSWORD, "bob");
    const next = await createAccountMaterial("bob", "a brand new passphrase");
    // reuse bob's existing keypair: seal the *current* private key with the new wrap key
    const { wrapKey } = await deriveFromPassword("a brand new passphrase", "bob");
    const sealed = await seal(bob.privateKey, wrapKey, privateKeyAad("bob"));
    await client(bob.token).changePassword({
      currentAuthKey: current,
      newAuthKey: next.authKey,
      newKdf: next.kdf,
      newWrappedPrivateKey: sealed,
    });
    await assert.rejects(oldSession.me(), /Invalid auth token/);
    await assert.rejects(login("bob"), /Invalid username or password/);
    const again = await login("bob", "a brand new passphrase");
    assert.equal(again.privateKey, bob.privateKey);
    bobAdmin = again;
  });

  it("a replaced session can be retired with its own token (unlock flow)", async () => {
    const first = await login("bob", "a brand new passphrase");
    const second = await login("bob", "a brand new passphrase");
    const before = await second.api.sessions.list();
    const mine = (await first.api.sessions.list()).find((s: any) => s.current);
    assert.ok(mine, "old token sees itself as current");
    await first.api.sessions.revoke({ id: mine.id });
    await assert.rejects(first.api.me(), /Invalid auth token/);
    const after = await second.api.sessions.list();
    assert.equal(after.length, before.length - 1);
    assert.ok(after.some((s: any) => s.current), "new session survives");
  });

  it("refuses weak KDF parameters", async () => {
    const m = await createAccountMaterial("zed", PASSWORD);
    const base = {
      username: "zed", authKey: m.authKey, publicKey: m.publicKey,
      wrappedPrivateKey: m.wrappedPrivateKey, recovery: recoveryOf(m),
    };
    await assert.rejects(client().signup({ ...base, kdf: { alg: "argon2id", m: 1024, t: 1, p: 1 } }), /key-derivation|invite/i);
    await assert.rejects(client().signup({ ...base, kdf: { alg: "pbkdf2-sha256", iterations: 1000 } }), /key-derivation|invite/i);
  });

  it("recovers an account with the recovery key — and not with a wrong one", async () => {
    const carol = await signup("carol", (await admin2().api.admin.invites.create({ expiresInHours: 1 })).token);
    const wrong = await createAccountMaterial("carol", PASSWORD); // unrelated recovery key
    await assert.rejects(
      client().recovery.bundle({ username: "carol", recoveryAuthKey: wrong.recovery.recoveryAuthKey }),
      /Invalid username or recovery key/,
    );
    await assert.rejects(
      client().recovery.bundle({ username: "nobody", recoveryAuthKey: wrong.recovery.recoveryAuthKey }),
      /Invalid username or recovery key/,
    );

    // Forgot the password: recover with the recovery key, set a new one.
    const { recoveryAuthKey, recoveryWrapKey } = await deriveRecoveryKeys(carol.recoveryKey!);
    const bundle = await client().recovery.bundle({ username: "carol", recoveryAuthKey });
    const privateKey = await openRecoveredPrivateKey(bundle.recoveryWrappedPrivateKey, recoveryWrapKey, "carol");
    assert.equal(privateKey, carol.privateKey);

    const fresh = await deriveFromPassword("my new password after recovery", "carol", DEFAULT_KDF);
    const result = await client().recovery.recover({
      username: "carol", recoveryAuthKey,
      newAuthKey: fresh.authKey, newKdf: DEFAULT_KDF,
      newWrappedPrivateKey: await seal(privateKey, fresh.wrapKey, privateKeyAad("carol")),
    });
    await assert.rejects(client(carol.token).me(), /Invalid auth token/, "old sessions revoked");
    assert.equal((await client(result.token).me()).username, "carol");
    assert.equal((await login("carol", "my new password after recovery")).privateKey, carol.privateKey);
    await assert.rejects(login("carol"), /Invalid username or password/);

    // The recovery key can be replaced.
    const again = await createAccountMaterial("carol", "x".repeat(12));
    // ...but only with the current password: a session alone isn't enough.
    await assert.rejects(
      client(result.token).recovery.set({ ...recoveryOf(again), currentAuthKey: again.authKey }),
      /Invalid current password/,
    );
    await assert.rejects(
      client(result.token).recovery.set(recoveryOf(again) as never),
      "the current password is required",
    );
    assert.ok(
      (await client().recovery.bundle({ username: "carol", recoveryAuthKey })).publicKey,
      "a refused replacement leaves the old recovery key working",
    );
    await client(result.token).recovery.set({ ...recoveryOf(again), currentAuthKey: fresh.authKey });
    await assert.rejects(
      client().recovery.bundle({ username: "carol", recoveryAuthKey }),
      /Invalid username or recovery key/,
    );
  });

  it("service accounts: scoped machine access, no human powers, revocable with rotation", async () => {
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const tid = org.id;
    const svcKeys = await generateIdentityKeyPair();
    const created = await admin.api.serviceAccounts.create({
      tenantId: tid, name: "ci", publicKey: svcKeys.publicKey, expiresInDays: 30,
    });
    assert.equal(created.username, "svc-ci");

    // Grant the service read access to one environment (client-side wrap).
    const proj = "api";
    const list = await admin.api.environments.list({ tenantId: tid, project: proj });
    const dek = await unwrapSecretWithPrivateKey(list[0].wrappedEnvDek, admin.privateKey);
    await grantAccess(admin.api, {
      tenantId: tid, project: proj, name: "default", username: "svc-ci", level: "read",
      wrappedEnvDek: await wrapSecretForPublicKey(dek, svcKeys.publicKey),
    });

    // The CI box only has the token string.
    const token = encodeServiceToken({ v: 1, u: created.username, t: created.token, k: svcKeys.privateKey, w: tid, r: "http://hub.test" });
    const t = decodeServiceToken(token);
    const svc: User = { username: t.u, token: t.t, privateKey: t.k, publicKey: svcKeys.publicKey, api: client(t.t) };
    const before = await readEnv(svc, tid, proj);
    assert.ok(before);

    // …but cannot do human things.
    assert.equal((await svc.api.me()).kind, "service");
    const left = Date.parse((await svc.api.me()).expiresAt) - Date.now();
    assert.ok(left > 29 * 86_400_000 && left <= 30 * 86_400_000, "a service token reports when it expires");
    assert.equal((await admin.api.me()).expiresAt, undefined);
    await assert.rejects(svc.api.tenants.create({ name: "evilcorp" }), /service accounts/i);
    await assert.rejects(svc.api.admin.users.list(), /Administrator access required/);
    await assert.rejects(svc.api.environments.saveEnv({
      tenantId: tid, project: proj, name: "default",
      payload: (await svc.api.environments.getEnv({ tenantId: tid, project: proj, name: "default" })).payload,
    }), /Requires write access/);
    await assert.rejects(login("svc-ci"), /Invalid username or password/);

    // Hidden from the human member list, listed under service accounts.
    assert.ok(!(await admin.api.tenants.members({ tenantId: tid })).some((m: any) => m.username === "svc-ci"));
    assert.equal((await admin.api.serviceAccounts.list({ tenantId: tid }))[0].username, "svc-ci");
    await assert.rejects(admin.api.tenants.removeMember({ tenantId: tid, username: "svc-ci" }), /Service tokens/);

    // Revoke: token dies immediately and the response lists what to rotate.
    const revoked = await admin.api.serviceAccounts.revoke({ tenantId: tid, username: "svc-ci" });
    assert.deepEqual(revoked.rotate, [{ project: proj, env: "default" }]);
    await assert.rejects(svc.api.me(), /Invalid auth token/);
  });

  it("only workspace managers can create service accounts", async () => {
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const keys = await generateIdentityKeyPair();
    await assert.rejects(
      client((await login("carol", "x".repeat(12)).catch(() => login("carol", "my new password after recovery"))).token)
        .serviceAccounts.create({ tenantId: org.id, name: "nope", publicKey: keys.publicKey }),
      /Not a member|Only owners/,
    );
  });

  it("service accounts can't use manage powers even when granted manage", async () => {
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const tid = org.id;
    const keys = await generateIdentityKeyPair();
    const created = await admin.api.serviceAccounts.create({
      tenantId: tid, name: "ci2", publicKey: keys.publicKey, expiresInDays: 30,
    });
    const list = await admin.api.environments.list({ tenantId: tid, project: "api" });
    const dek = await unwrapSecretWithPrivateKey(list[0].wrappedEnvDek, admin.privateKey);
    const wrapped = await wrapSecretForPublicKey(dek, keys.publicKey);
    await grantAccess(admin.api, {
      tenantId: tid, project: "api", name: "default", username: created.username, level: "manage", wrappedEnvDek: wrapped,
    });
    const svc = client(created.token);
    const loc = { tenantId: tid, project: "api", name: "default" };
    const payload = (await svc.environments.getEnv(loc)).payload; // reading is still allowed
    await assert.rejects(grantAccess(svc, { ...loc, username: "alice", level: "read", wrappedEnvDek: wrapped }), /service accounts/i);
    await assert.rejects(svc.environments.rotate({ ...loc, payload, keyWraps: [{ username: created.username, wrappedEnvDek: wrapped }] }), /service accounts/i);
    await assert.rejects(svc.environments.listAccess(loc), /service accounts/i);
    await assert.rejects(svc.environments.delete({ ...loc, name: "nope" }), /service accounts/i);
    await assert.rejects(svc.environments.create({ ...loc, name: "extra", payload, keyWraps: [{ username: created.username, wrappedEnvDek: wrapped }] }), /service accounts/i);
    await assert.rejects(svc.projects.delete({ tenantId: tid, name: "api" }), /service accounts/i);
    await admin.api.serviceAccounts.revoke({ tenantId: tid, username: created.username });
  });

  it("kubernetes links: the hub keeps the mapping, the operator reports back, unlinking revokes", async () => {
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const tid = org.id;
    const loc = { tenantId: tid, project: "api", name: "default" };
    const keys = await generateIdentityKeyPair();
    const cluster = await admin.api.serviceAccounts.create({ tenantId: tid, name: "k8s-main", publicKey: keys.publicKey, expiresInDays: 30 });
    assert.equal(cluster.username, "svc-k8s-main");
    const list = await admin.api.environments.list({ tenantId: tid, project: "api" });
    const dek = await unwrapSecretWithPrivateKey(list[0].wrappedEnvDek, admin.privateKey);
    const link = { ...loc, cluster: cluster.username, namespace: "prod", secretName: "api-env", direction: "pull" };

    // The cluster token must hold the key first: the hub cannot wrap one.
    await assert.rejects(admin.api.k8s.links.create(link), /needs read access/);
    await grantAccess(admin.api, { ...loc, username: cluster.username, level: "read", wrappedEnvDek: await wrapSecretForPublicKey(dek, keys.publicKey) });
    const made = await admin.api.k8s.links.create(link);
    assert.equal(made.status, "");
    await assert.rejects(admin.api.k8s.links.create(link), /already linked/);
    await assert.rejects(admin.api.k8s.links.create({ ...link, secretName: "b", direction: "push" }), /needs write access/);
    await assert.rejects(admin.api.k8s.links.create({ ...link, secretName: "Bad_Name" }), /Input validation failed/);

    // Not a person's job to impersonate the operator, nor the operator's to manage links.
    const agent = client(cluster.token);
    await assert.rejects(agent.k8s.links.create({ ...link, secretName: "x" }), /service accounts/i);
    await assert.rejects(admin.api.k8s.agent.sync({}), /cluster token/);

    // The operator polls: it is seen, tells which namespaces it may use, and receives its links.
    const got = await agent.k8s.agent.sync({ version: "0.2.0", namespaces: ["prod", "staging"] });
    assert.deepEqual(got.map((l: any) => [l.namespace, l.secretName, l.direction, l.project, l.environment]), [["prod", "api-env", "pull", "api", "default"]]);
    await assert.rejects(admin.api.k8s.links.create({ ...link, namespace: "kube-system", secretName: "y" }), /may not use the namespace/);
    const clusters = await admin.api.k8s.clusters.list({ tenantId: tid });
    assert.deepEqual(clusters.map((c: any) => [c.cluster, c.version, c.namespaces, c.lastSeen !== null]), [["svc-k8s-main", "0.2.0", ["prod", "staging"], true]]);

    // It reports status (a short reason and a count; never values), shown on the environment.
    await agent.k8s.agent.report({ reports: [{ id: made.id, status: "Synced", message: "Secret is up to date", keyCount: 3 }, { id: "someone-elses", status: "Synced" }] });
    const shown = (await admin.api.k8s.links.list(loc))[0];
    assert.deepEqual([shown.status, shown.keyCount, shown.reportedAt !== ""], ["Synced", 3, true]);

    // Unlinking removes the mapping and the cluster token's access to that environment.
    assert.equal((await admin.api.k8s.links.delete({ tenantId: tid, id: made.id })).revoked, true);
    assert.deepEqual(await admin.api.k8s.links.list(loc), []);
    assert.deepEqual(await agent.k8s.agent.sync({ namespaces: [] }), []);
    await assert.rejects(agent.environments.getEnv(loc), /No access|Requires/);
    await admin.api.serviceAccounts.revoke({ tenantId: tid, username: cluster.username });
  });

  it("kubernetes cluster tokens: extend a live one, replace one that expired", async () => {
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const tid = org.id;
    const loc = { tenantId: tid, project: "api", name: "default" };
    const list = await admin.api.environments.list({ tenantId: tid, project: "api" });
    const dek = await unwrapSecretWithPrivateKey(list[0].wrappedEnvDek, admin.privateKey);
    const old = await generateIdentityKeyPair();
    const oldAcct = await admin.api.serviceAccounts.create({ tenantId: tid, name: "k8s-old", publicKey: old.publicKey, expiresInDays: 5 });
    await grantAccess(admin.api, { ...loc, username: oldAcct.username, level: "write", wrappedEnvDek: await wrapSecretForPublicKey(dek, old.publicKey) });
    const made = await admin.api.k8s.links.create({ ...loc, cluster: oldAcct.username, namespace: "prod", secretName: "api-env", direction: "push" });

    // Extending is the same token with more time: the hub's own record shows it at once.
    const agent = client(oldAcct.token);
    const before = (await agent.me()).expiresAt;
    const ext = await admin.api.k8s.clusters.extend({ tenantId: tid, cluster: oldAcct.username, expiresInDays: 365 });
    assert.ok(ext.expiresAt > before);
    assert.equal((await agent.me()).expiresAt, ext.expiresAt);
    assert.equal((await admin.api.k8s.clusters.list({ tenantId: tid })).find((c: any) => c.cluster === oldAcct.username).expiresAt, ext.expiresAt);
    await assert.rejects(admin.api.k8s.clusters.extend({ tenantId: tid, cluster: "svc-nobody" }), /Not a cluster token/);

    // A replacement must hold the same access first; then the links move with their ids.
    const fresh = await generateIdentityKeyPair();
    const newAcct = await admin.api.serviceAccounts.create({ tenantId: tid, name: "k8s-new", publicKey: fresh.publicKey, expiresInDays: 365 });
    const carried = await admin.api.k8s.clusters.links({ tenantId: tid, cluster: oldAcct.username });
    assert.deepEqual(carried.map((l: any) => l.id), [made.id]);
    await assert.rejects(admin.api.k8s.clusters.replace({ tenantId: tid, from: oldAcct.username, to: newAcct.username }), /no access yet to: api\/default/);
    await grantAccess(admin.api, { ...loc, username: newAcct.username, level: "write", wrappedEnvDek: await wrapSecretForPublicKey(dek, fresh.publicKey) });
    await assert.rejects(admin.api.k8s.clusters.replace({ tenantId: tid, from: oldAcct.username, to: oldAcct.username }), /different token/);
    assert.equal((await admin.api.k8s.clusters.replace({ tenantId: tid, from: oldAcct.username, to: newAcct.username })).moved, 1);
    const moved = await client(newAcct.token).k8s.agent.sync({ namespaces: ["prod"] });
    assert.deepEqual(moved.map((l: any) => l.id), [made.id]);
    assert.deepEqual(await agent.k8s.agent.sync({ namespaces: [] }), []);

    // Once a token is gone (expired or revoked) it cannot be extended.
    await admin.api.serviceAccounts.revoke({ tenantId: tid, username: oldAcct.username });
    await assert.rejects(admin.api.k8s.clusters.extend({ tenantId: tid, cluster: oldAcct.username }), /already expired/);

    await admin.api.k8s.links.delete({ tenantId: tid, id: made.id });
    await admin.api.serviceAccounts.revoke({ tenantId: tid, username: newAcct.username });
  });

  it("kubernetes links go away with their environment, project or cluster token", async () => {
    const org = await admin.api.tenants.create({ name: "k8s-cleanup" });
    const tid = org.id;
    const me = (await admin.api.tenants.keyRecipients({ tenantId: tid })).find((r: any) => r.username === "alice");
    const keys = await generateIdentityKeyPair();
    const acct = await admin.api.serviceAccounts.create({ tenantId: tid, name: "k8s-c", publicKey: keys.publicKey, expiresInDays: 30 });
    const dekOf = await makeProject(admin, tid, "p", { A: "1" });
    const staging = generateDek();
    await admin.api.environments.create({
      tenantId: tid, project: "p", name: "staging",
      payload: await sealEnv({ B: "2" }, staging, envAad(tid, "p", "staging")),
      keyWraps: [{ username: "alice", wrappedEnvDek: await wrapSecretForPublicKey(staging, me.publicKey) }],
    });
    const stagingDek = staging;
    const linkTo = async (project: string, env: string, dek: string, secretName: string) => {
      await grantAccess(admin.api, { tenantId: tid, project, name: env, username: acct.username, level: "read", wrappedEnvDek: await wrapSecretForPublicKey(dek, keys.publicKey) });
      return admin.api.k8s.links.create({ tenantId: tid, project, name: env, cluster: acct.username, namespace: "ns", secretName, direction: "pull" });
    };
    await linkTo("p", "default", dekOf, "one");
    await linkTo("p", "staging", stagingDek, "two");
    const agent = client(acct.token);
    assert.equal((await agent.k8s.agent.sync({ namespaces: ["ns"] })).length, 2);

    // Deleting an environment takes its links, and frees the Secret name.
    await admin.api.environments.delete({ tenantId: tid, project: "p", name: "staging" });
    assert.deepEqual((await agent.k8s.agent.sync({ namespaces: ["ns"] })).map((l: any) => l.secretName), ["one"]);

    // Deleting the project takes the rest.
    await admin.api.projects.delete({ tenantId: tid, name: "p" });
    assert.deepEqual(await agent.k8s.agent.sync({ namespaces: ["ns"] }), []);

    // Revoking a cluster token takes its links, and its heartbeat row.
    const dek2 = await makeProject(admin, tid, "q", { A: "1" });
    await linkTo("q", "default", dek2, "three");
    await admin.api.serviceAccounts.revoke({ tenantId: tid, username: acct.username });
    assert.deepEqual(await admin.api.k8s.links.list({ tenantId: tid, project: "q", name: "default" }), []);
    const left = await admin.api.k8s.clusters.list({ tenantId: tid });
    assert.deepEqual(left.map((c: any) => [c.status, c.lastSeen]), [["disabled", null]]);
  });

  it("a pull link can be allowed to take over a Secret that already exists", async () => {
    const org = await admin.api.tenants.create({ name: "k8s-adopt" });
    const tid = org.id;
    const keys = await generateIdentityKeyPair();
    const acct = await admin.api.serviceAccounts.create({ tenantId: tid, name: "k8s-a", publicKey: keys.publicKey, expiresInDays: 30 });
    const dek = await makeProject(admin, tid, "p", { A: "1" });
    const wrapped = await wrapSecretForPublicKey(dek, keys.publicKey);
    await grantAccess(admin.api, { tenantId: tid, project: "p", name: "default", username: acct.username, level: "write", wrappedEnvDek: wrapped });
    const make = (secretName: string, direction: "pull" | "push", adopt?: boolean) =>
      admin.api.k8s.links.create({ tenantId: tid, project: "p", name: "default", cluster: acct.username, namespace: "ns", secretName, direction, ...(adopt === undefined ? {} : { adopt }) });

    const plain = await make("plain", "pull");
    const taking = await make("taking", "pull", true);
    const push = await make("src", "push", true); // a push never takes anything over
    assert.deepEqual([plain.adopt, taking.adopt, push.adopt], [false, true, false]);

    const agent = client(acct.token);
    const seen = (await agent.k8s.agent.sync({ namespaces: ["ns"] })).map((l: any) => [l.secretName, l.adopt]);
    assert.deepEqual(seen.sort(), [["plain", false], ["src", false], ["taking", true]]);

    // A conflicted link can be switched on afterwards, and off again; a push link cannot.
    assert.equal((await admin.api.k8s.links.adopt({ tenantId: tid, id: plain.id, adopt: true })).adopt, true);
    assert.equal((await agent.k8s.agent.sync({ namespaces: ["ns"] })).find((l: any) => l.id === plain.id).adopt, true);
    assert.equal((await admin.api.k8s.links.adopt({ tenantId: tid, id: plain.id, adopt: false })).adopt, false);
    await assert.rejects(() => admin.api.k8s.links.adopt({ tenantId: tid, id: push.id, adopt: true }), /writes a Secret/);

    // Someone who may not share the environment cannot change it.
    await assert.rejects(() => bob.api.k8s.links.adopt({ tenantId: tid, id: plain.id, adopt: true }));
  });

  it("one environment can be linked both ways, in either order, and the token keeps the access it needs", async () => {
    const org = await admin.api.tenants.create({ name: "k8s-both" });
    const tid = org.id;
    const keys = await generateIdentityKeyPair();
    const acct = await admin.api.serviceAccounts.create({ tenantId: tid, name: "k8s-b", publicKey: keys.publicKey, expiresInDays: 30 });
    const dek = await makeProject(admin, tid, "p", { A: "1" });
    const wrapped = await wrapSecretForPublicKey(dek, keys.publicKey);
    const grant = (level: "read" | "write") =>
      grantAccess(admin.api, { tenantId: tid, project: "p", name: "default", username: acct.username, level, wrappedEnvDek: wrapped });
    const link = (secretName: string, direction: "pull" | "push") =>
      admin.api.k8s.links.create({ tenantId: tid, project: "p", name: "default", cluster: acct.username, namespace: "ns", secretName, direction });
    const level = async () =>
      (await admin.api.environments.listAccess({ tenantId: tid, project: "p", name: "default" })).find((a: any) => a.username === acct.username)?.level;

    // What the dashboard does: grant first (replacing whatever the token had), then link.
    await grant("write");
    const push = await link("out", "push");
    await grant("read"); // the pull link's own grant would demote the token here
    const pull = await link("in", "pull");
    assert.equal(await level(), "write", "the push link still needs write after a pull link is added");

    // Removing the push link drops the token to what the pull link needs.
    await admin.api.k8s.links.delete({ tenantId: tid, id: push.id });
    assert.equal(await level(), "read");
    // Removing the last link revokes the access.
    await admin.api.k8s.links.delete({ tenantId: tid, id: pull.id });
    assert.equal(await level(), undefined);

    // The other order: pull first, then push.
    await grant("read");
    await link("in", "pull");
    await grant("write");
    await link("out", "push");
    assert.equal(await level(), "write");
  });

  it("only one Secret can push into an environment; pulls are unlimited", async () => {
    const org = await admin.api.tenants.create({ name: "k8s-one-push" });
    const tid = org.id;
    const keys = await generateIdentityKeyPair();
    const acct = await admin.api.serviceAccounts.create({ tenantId: tid, name: "k8s-one", publicKey: keys.publicKey, expiresInDays: 30 });
    const dek = await makeProject(admin, tid, "p", { A: "1" });
    await grantAccess(admin.api, {
      tenantId: tid, project: "p", name: "default", username: acct.username, level: "write",
      wrappedEnvDek: await wrapSecretForPublicKey(dek, keys.publicKey),
    });
    const link = (namespace: string, secretName: string, direction: "pull" | "push") =>
      admin.api.k8s.links.create({ tenantId: tid, project: "p", name: "default", cluster: acct.username, namespace, secretName, direction });

    const first = await link("ns-a", "out-a", "push");
    await assert.rejects(link("ns-b", "out-b", "push"), /already receives from ns-a\/out-a.*Only one Secret/s);
    await link("ns-a", "in-1", "pull"); // pulls only copy the environment out, so any number is fine
    await link("ns-b", "in-2", "pull");

    // Once the push link is gone another Secret may take its place (the dashboard grants write again first).
    await admin.api.k8s.links.delete({ tenantId: tid, id: first.id });
    await grantAccess(admin.api, {
      tenantId: tid, project: "p", name: "default", username: acct.username, level: "write",
      wrappedEnvDek: await wrapSecretForPublicKey(dek, keys.publicKey),
    });
    await link("ns-b", "out-b", "push");
  });

  it("the database lets only one of two simultaneous push links through", async () => {
    const org = await admin.api.tenants.create({ name: "k8s-race" });
    const tid = org.id;
    const keys = await generateIdentityKeyPair();
    const acct = await admin.api.serviceAccounts.create({ tenantId: tid, name: "k8s-race", publicKey: keys.publicKey, expiresInDays: 30 });
    const dek = await makeProject(admin, tid, "p", { A: "1" });
    await grantAccess(admin.api, {
      tenantId: tid, project: "p", name: "default", username: acct.username, level: "write",
      wrappedEnvDek: await wrapSecretForPublicKey(dek, keys.publicKey),
    });
    const push = (secretName: string) =>
      admin.api.k8s.links.create({ tenantId: tid, project: "p", name: "default", cluster: acct.username, namespace: "ns", secretName, direction: "push" });
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => push(`race-${i}`)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one push link exists");
    for (const r of results) if (r.status === "rejected") assert.match(String(r.reason?.message), /already receives from ns\/race-\d.*Only one Secret/s);
    assert.equal((await admin.api.k8s.links.list({ tenantId: tid, project: "p", name: "default" })).length, 1);
  });

  it("deleting a project needs owner/admin or manage on every environment", async () => {
    const alice = admin;
    const bobNow = await login("bob", "a brand new passphrase");
    const org = await alice.api.tenants.create({ name: "scoped" });
    await alice.api.tenants.invite({ tenantId: org.id, username: "bob", role: "member" });
    await bobNow.api.tenants.acceptInvite({ tenantId: org.id });

    const dek = await makeProject(alice, org.id, "p", { A: "1" });
    // A second environment, keyed for the owner only.
    const staging = generateDek();
    const me = (await alice.api.tenants.keyRecipients({ tenantId: org.id })).find((r: any) => r.username === "alice");
    await alice.api.environments.create({
      tenantId: org.id, project: "p", name: "staging",
      payload: await sealEnv({ B: "2" }, staging, envAad(org.id, "p", "staging")),
      keyWraps: [{ username: "alice", wrappedEnvDek: await wrapSecretForPublicKey(staging, me.publicKey) }],
    });
    // bob manages only `default`.
    await grantAccess(alice.api, {
      tenantId: org.id, project: "p", name: "default", username: "bob", level: "manage",
      wrappedEnvDek: await wrapSecretForPublicKey(dek, bobNow.publicKey),
    });
    await assert.rejects(bobNow.api.projects.delete({ tenantId: org.id, name: "p" }), /owner\/admin|every environment/i);
    assert.equal((await alice.api.projects.list({ tenantId: org.id })).length, 1, "project survives");

    // Once bob manages every environment he may delete it; the owner always can.
    await grantAccess(alice.api, {
      tenantId: org.id, project: "p", name: "staging", username: "bob", level: "manage",
      wrappedEnvDek: await wrapSecretForPublicKey(staging, bobNow.publicKey),
    });
    await bobNow.api.projects.delete({ tenantId: org.id, name: "p" });
    assert.equal((await alice.api.projects.list({ tenantId: org.id })).length, 0);
  });

  it("access carries separate delete, share and rotate permissions on top of read/write", async () => {
    const alice = admin;
    // Fresh accounts, with the shared address's rate limit reset so the earlier tests don't count.
    await db.deleteFrom("rate_limits").execute();
    const bobNow = await signup("frank", (await admin2().api.admin.invites.create({ expiresInHours: 1 })).token);
    const erin = await signup("erin", (await admin2().api.admin.invites.create({ expiresInHours: 1 })).token);
    const org = await alice.api.tenants.create({ name: "caps" });
    const tid = org.id;
    for (const u of [bobNow, erin]) {
      await alice.api.tenants.invite({ tenantId: tid, username: u.username, role: "member" });
      await u.api.tenants.acceptInvite({ tenantId: tid });
    }

    let dek = await makeProject(alice, tid, "perm", { A: "1" });
    const staging = generateDek();
    const me = (await alice.api.tenants.keyRecipients({ tenantId: tid })).find((r: any) => r.username === "alice");
    await alice.api.environments.create({
      tenantId: tid, project: "perm", name: "staging",
      payload: await sealEnv({ B: "2" }, staging, envAad(tid, "perm", "staging")),
      keyWraps: [{ username: "alice", wrappedEnvDek: await wrapSecretForPublicKey(staging, me.publicKey) }],
    });
    const loc = { tenantId: tid, project: "perm", name: "default" };
    /** The owner sets someone's access on `default` (or another environment). */
    const grant = async (who: User, level: string, caps?: string[], env = "default", key = dek) =>
      grantAccess(alice.api, {
        tenantId: tid, project: "perm", name: env, username: who.username, level, ...(caps ? { caps } : {}),
        wrappedEnvDek: await wrapSecretForPublicKey(key, who.publicKey),
      });
    const save = async (u: User, env: Record<string, string>) => {
      const cur = await u.api.environments.getEnv(loc);
      return u.api.environments.saveEnv({ ...loc, payload: await sealEnv(env, dek, envAad(tid, "perm", "default")), baseUpdatedAt: cur.updatedAt });
    };
    const denied = /permission on this environment/;

    // Plain write: reads and saves, but nothing destructive, no sharing, no re-keying.
    await grant(bobNow, "write");
    await save(bobNow, { A: "2" });
    await save(bobNow, { A: "3" });
    const versions = await bobNow.api.environments.versions.list(loc);
    assert.ok(versions.history.length >= 1);
    await assert.rejects(bobNow.api.environments.versions.delete({ ...loc, id: versions.history[0].id }), denied);
    await assert.rejects(bobNow.api.environments.delete(loc), denied);
    await assert.rejects(bobNow.api.environments.listAccess(loc), denied);
    await assert.rejects(bobNow.api.environments.versions.export(loc), denied);
    await assert.rejects(
      grantAccess(bobNow.api, { ...loc, username: "erin", level: "read", wrappedEnvDek: "x" }),
      denied,
    );

    // The delete permission alone allows deleting versions, nothing else.
    await grant(bobNow, "write", ["delete"]);
    await bobNow.api.environments.versions.delete({ ...loc, id: versions.history[0].id });
    await assert.rejects(bobNow.api.environments.listAccess(loc), denied);
    await assert.rejects(bobNow.api.environments.versions.export(loc), denied);

    // Share lets you grant up to your own access: never more, and never over someone above you.
    await grant(bobNow, "write", ["share"]);
    const wrapFor = (who: User, key = dek) => wrapSecretForPublicKey(key, who.publicKey);
    await grantAccess(bobNow.api, { ...loc, username: "erin", level: "read", wrappedEnvDek: await wrapFor(erin) });
    assert.deepEqual(await readEnv(erin, tid, "perm"), { A: "3" });
    for (const more of [
      { level: "read" as const, caps: ["delete"] },
      { level: "manage" as const, caps: [] as string[] },
    ]) {
      await assert.rejects(
        grantAccess(bobNow.api, { ...loc, username: "erin", ...more, wrappedEnvDek: await wrapFor(erin) }),
        /more access than you have/,
      );
    }
    const access = await bobNow.api.environments.listAccess(loc);
    assert.deepEqual(access.find((a: any) => a.username === "alice")?.caps, ["delete", "share", "rotate"]);
    assert.deepEqual(access.find((a: any) => a.username === "erin")?.caps, []);
    // Once erin holds delete she is above a plain sharer, who can no longer rewrite her access.
    await grant(erin, "write", ["delete"]);
    await assert.rejects(
      grantAccess(bobNow.api, { ...loc, username: "erin", level: "read", wrappedEnvDek: await wrapFor(erin) }),
      /access you don't have/,
    );

    // Rotate re-keys and revokes, but only people whose access you cover.
    await grant(bobNow, "write", ["rotate"]);
    const fresh = generateDek();
    const payload = await sealEnv({ A: "3" }, fresh, envAad(tid, "perm", "default"));
    const wrapsFor = (users: User[]) =>
      Promise.all(users.map(async (u) => ({ username: u.username, wrappedEnvDek: await wrapFor(u, fresh) })));
    await assert.rejects(
      bobNow.api.environments.rotate({ ...loc, payload, keyWraps: await wrapsFor([alice, bobNow]) }),
      /can't revoke/,
    );
    await bobNow.api.environments.rotate({ ...loc, payload, keyWraps: await wrapsFor([alice, bobNow, erin]) });
    dek = fresh;

    // Write plus every permission is stored as a manager.
    await grant(bobNow, "write", ["delete", "share", "rotate"]);
    assert.equal((await alice.api.environments.listAccess(loc)).find((a: any) => a.username === "frank")?.level, "manage");

    // Deleting the project needs the delete permission on every environment.
    await grant(bobNow, "write", ["delete"]);
    await assert.rejects(bobNow.api.projects.delete({ tenantId: tid, name: "perm" }), /owner\/admin|every environment|delete permission/i);
    await grant(bobNow, "read", ["delete"], "staging", staging);
    await bobNow.api.projects.delete({ tenantId: tid, name: "perm" });
    assert.equal((await alice.api.projects.list({ tenantId: tid })).length, 0);
  });

  it("a stale save loses instead of silently overwriting", async () => {
    const { saveStoredEnvironmentIf, getStoredEnvironment } = await import("../src/db/store.js");
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const current = await getStoredEnvironment(db, org.id, "api", "default");
    assert.ok(current);
    const next = (at: string) => ({ ...current, updatedAt: at });
    assert.equal(await saveStoredEnvironmentIf(db, next("2099-01-01T00:00:00.000Z"), current.updatedAt), true);
    // A second writer that read the same version now loses.
    assert.equal(await saveStoredEnvironmentIf(db, next("2099-01-02T00:00:00.000Z"), current.updatedAt), false);
    const after = await getStoredEnvironment(db, org.id, "api", "default");
    assert.equal(after?.updatedAt, "2099-01-01T00:00:00.000Z");
    // Put it back so later tests see the original timestamp.
    await saveStoredEnvironmentIf(db, { ...current }, "2099-01-01T00:00:00.000Z");
  });

  it("keeps a version history you can read, re-key, prune and delete", async () => {
    const { saveStoredEnvironmentIf, getStoredEnvironment, MAX_ENV_HISTORY } = await import("../src/db/store.js");
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const tid = org.id;
    const loc = { tenantId: tid, project: "api", name: "default" };
    const aad = envAad(tid, "api", "default");
    const meta = (await admin.api.environments.list({ tenantId: tid, project: "api" })).find((e: any) => e.name === "default");
    const dek = await unwrapSecretWithPrivateKey(meta.wrappedEnvDek, admin.privateKey);
    const save = async (env: Record<string, string>, note?: string) => {
      const cur = await admin.api.environments.getEnv(loc);
      return admin.api.environments.saveEnv({ ...loc, payload: await sealEnv(env, dek, aad), baseUpdatedAt: cur.updatedAt, note });
    };

    const before = await admin.api.environments.versions.list(loc);
    await save({ KEY: "one" }, "first draft");
    await save({ KEY: "two" });
    const after = await admin.api.environments.versions.list(loc);
    assert.equal(after.current.version, before.current.version + 2);
    assert.equal(after.current.updatedBy, "alice");
    assert.equal(after.history.length, before.history.length + 2);
    assert.equal(after.history[0].version, before.current.version + 1);
    assert.equal(after.history[0].note, "first draft");
    assert.ok(!("payload" in after.history[0]), "listing carries no ciphertext");

    // An old version opens with the environment's key and is audited as a read.
    const old = await admin.api.environments.versions.get({ ...loc, id: after.history[0].id });
    assert.deepEqual(await openEnv(old.payload, dek, aad), { KEY: "one" });
    await assert.rejects(admin.api.environments.versions.get({ ...loc, id: "nope" }), /not found/i);

    // Rotation: history is re-encrypted under the new key; the old key no longer opens it.
    const acl = await admin.api.environments.listAccess(loc);
    const newDek = generateDek();
    const keyWraps = await Promise.all(
      acl.map(async (a: any) => ({
        username: a.username,
        wrappedEnvDek: await wrapSecretForPublicKey(newDek, (await admin.api.users.resolve({ username: a.username })).publicKey),
      })),
    );
    const exported = await admin.api.environments.versions.export(loc);
    assert.equal(exported.length, after.history.length);
    const keepIds = new Set(exported.slice(0, 2).map((v: any) => v.id)); // keep only the two newest
    const history = await Promise.all(
      exported.filter((v: any) => keepIds.has(v.id)).map(async (v: any) => ({
        id: v.id,
        payload: await sealEnv(await openEnv(v.payload, dek, aad), newDek, aad),
      })),
    );
    const cur = await admin.api.environments.getEnv(loc);
    await admin.api.environments.rotate({
      ...loc,
      payload: await sealEnv(await openEnv(cur.payload, dek, aad), newDek, aad),
      keyWraps, history, baseUpdatedAt: cur.updatedAt,
    });
    const rotated = await admin.api.environments.versions.list(loc);
    assert.equal(rotated.current.version, after.current.version, "rotation is not a new version");
    assert.equal(rotated.history.length, 2, "history that wasn't re-encrypted is dropped");
    const reread = await admin.api.environments.versions.get({ ...loc, id: rotated.history[0].id });
    assert.deepEqual(await openEnv(reread.payload, newDek, aad), { KEY: "one" });
    await assert.rejects(openEnv(reread.payload, dek, aad), "old key can't open re-keyed history");
    await assert.rejects(
      admin.api.environments.rotate({
        ...loc, payload: reread.payload, keyWraps, history: [{ id: "not-mine", payload: reread.payload }],
        baseUpdatedAt: (await admin.api.environments.getEnv(loc)).updatedAt,
      }),
      /isn't part of this environment/,
    );

    // Deleting one version leaves the rest.
    await admin.api.environments.versions.delete({ ...loc, id: rotated.history[1].id });
    assert.equal((await admin.api.environments.versions.list(loc)).history.length, 1);
    await assert.rejects(admin.api.environments.versions.delete({ ...loc, id: rotated.history[1].id }), /not found/i);

    // The history is capped at the newest MAX_ENV_HISTORY.
    for (let i = 0; i < MAX_ENV_HISTORY + 5; i++) {
      const current = await getStoredEnvironment(db, tid, "api", "default");
      assert.ok(current);
      assert.equal(await saveStoredEnvironmentIf(db, { ...current, updatedAt: new Date(Date.now() + i + 1).toISOString() }, current.updatedAt, { by: "alice" }), true);
    }
    const capped = await admin.api.environments.versions.list(loc);
    assert.equal(capped.history.length, MAX_ENV_HISTORY);
    assert.ok(capped.history[0].version > capped.history[capped.history.length - 1].version, "newest first");
  });

  it("records an audit trail without secrets; viewing is restricted", async () => {
    const org = (await admin.api.tenants.list()).find((t: any) => t.slug === "acme");
    const all = await admin2().api.admin.audit.list({ limit: 200 });
    const actions = new Set(all.map((e: any) => e.action));
    for (const a of ["account.signup", "account.login", "account.login_failed", "project.create", "env.read", "env.save", "env.grant", "env.rotate", "invite.create", "invite.revoke", "user.disable", "service.create", "service.revoke", "account.recovered", "account.password_changed"]) {
      assert.ok(actions.has(a), `audit has ${a}`);
    }
    const dump = JSON.stringify(all);
    assert.ok(!dump.includes("TOPSECRET") && !dump.includes("postgres://prod") && !dump.includes(PASSWORD));
    assert.ok(all[0].at >= all[all.length - 1].at, "newest first");

    const scoped = await admin.api.tenants.audit({ tenantId: org.id, limit: 100 });
    assert.ok(scoped.length > 0 && scoped.every((e: any) => e.tenantId === org.id));
    const page = await admin2().api.admin.audit.list({ limit: 2, before: all[1].at });
    assert.ok(page.every((e: any) => e.at < all[1].at));

    const plain = await login("carol", "my new password after recovery");
    await assert.rejects(plain.api.admin.audit.list({}), /Administrator access required/);
    await assert.rejects(plain.api.tenants.audit({ tenantId: org.id }), /Not a member|Only owners/);
  });
});

describe("schema upgrade", () => {
  it("adds the history columns and table to a database from the previous schema", async () => {
    const { ensureSchema } = await import("../src/db/store.js");
    const { sql } = await import("kysely");
    const upgradeDir = mkdtempSync(join(tmpdir(), "envvault-upgrade-"));
    try {
      const old = await openDb(join(upgradeDir, "vault.db"));
      // Rewind to the previous shape: no history columns/table, older schema stamp.
      await sql`DROP TABLE environment_versions`.execute(old);
      for (const c of ["version", "updated_by", "note", "key_version"]) {
        await sql.raw(`ALTER TABLE environments DROP COLUMN ${c}`).execute(old);
      }
      await sql`ALTER TABLE environment_acl DROP COLUMN caps`.execute(old);
      await old.updateTable("settings").set({ value: "zk-3" }).where("key", "=", "schema_version").execute();
      await sql`INSERT INTO environments (tenant_id, project_name, name, updated_at, payload, rotate_pending)
                VALUES ('t', 'p', 'default', '2020-01-01T00:00:00.000Z', '{}', 0)`.execute(old);

      await ensureSchema(old);

      const row = await old.selectFrom("environments").selectAll().executeTakeFirstOrThrow();
      assert.equal(Number(row.version), 1, "existing environments start at version 1");
      assert.equal(row.updated_by, "");
      assert.equal(row.note, "");
      assert.equal(Number(row.key_version), 1, "existing environments start at key generation 1");
      assert.deepEqual(await old.selectFrom("environment_versions").selectAll().execute(), []);
      await old.insertInto("environment_acl").values({ tenant_id: "t", project_name: "p", env_name: "default", username: "u", level: "write", caps: "" }).execute();
      assert.equal((await old.selectFrom("environment_acl").selectAll().executeTakeFirstOrThrow()).caps, "", "existing grants keep their level and gain no capabilities");
    } finally {
      rmSync(upgradeDir, { recursive: true, force: true });
    }
  });

  it("a database with two pushes into one environment still starts, names them, and keeps the rule for new links", async () => {
    const { ensureSchema } = await import("../src/db/store.js");
    const { sql } = await import("kysely");
    const dir = mkdtempSync(join(tmpdir(), "envvault-dup-"));
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (m: unknown) => void warnings.push(String(m));
    try {
      const old = await openDb(join(dir, "vault.db"));
      await sql`DROP INDEX IF EXISTS k8s_links_one_push_idx`.execute(old);
      const ins = (id: string, secret: string) =>
        sql`INSERT INTO k8s_links (id, tenant_id, project_name, env_name, cluster, namespace, secret_name, direction, created_by, created_at)
            VALUES (${id}, 't', 'p', 'default', 'svc-k8s-x', 'ns', ${secret}, 'push', 'alice', '2020-01-01T00:00:00.000Z')`.execute(old);
      await ins("a", "first");
      await ins("b", "second"); // made before the rule existed

      await ensureSchema(old); // must not throw
      assert.ok(warnings.some((w) => /p\/default.*first.*second|p\/default.*second.*first/.test(w)), `warned: ${warnings.join(" | ")}`);
      await ins("c", "third"); // no index yet, so the database does not object; the handler check does

      // Clean up to one and the next start makes the index.
      await sql`DELETE FROM k8s_links WHERE id IN ('b', 'c')`.execute(old);
      await ensureSchema(old);
      await assert.rejects(ins("d", "fourth"), /UNIQUE|unique/);
    } finally {
      console.warn = realWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds the take-over column to a links table made before it existed", async () => {
    const { ensureSchema } = await import("../src/db/store.js");
    const { sql } = await import("kysely");
    const upgradeDir = mkdtempSync(join(tmpdir(), "envvault-upgrade-"));
    try {
      const old = await openDb(join(upgradeDir, "vault.db"));
      await sql`ALTER TABLE k8s_links DROP COLUMN adopt`.execute(old);
      await sql`INSERT INTO k8s_links (id, tenant_id, project_name, env_name, cluster, namespace, secret_name, direction, created_by, created_at)
                VALUES ('l', 't', 'p', 'default', 'svc-k8s-x', 'ns', 's', 'pull', 'alice', '2020-01-01T00:00:00.000Z')`.execute(old);

      await ensureSchema(old);

      const row = await old.selectFrom("k8s_links").selectAll().executeTakeFirstOrThrow();
      assert.equal(Number(row.adopt), 0, "existing links keep refusing to touch a Secret they did not write");
    } finally {
      rmSync(upgradeDir, { recursive: true, force: true });
    }
  });
});
