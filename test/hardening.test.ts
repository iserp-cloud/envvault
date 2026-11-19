import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  sealEnv,
  wrapSecretForPublicKey,
} from "@envvault/shared";
import type { Kysely } from "kysely";
import { openDb } from "../src/db/index.js";
import type { Database } from "../src/db/schema.js";
import { appRouter } from "../src/rpc/router.js";
import { clientIp } from "../src/ratelimit.js";
import { ensureSetupToken } from "../src/setup-token.js";
import { securityHeaders } from "../src/security.js";


/** Share an environment the way a client does: with the key generation it just loaded. */
async function grantAccess(api: any, input: any) {
  const rows = await api.environments.list({ tenantId: input.tenantId, project: input.project }).catch(() => []);
  const keyVersion = rows.find((e: any) => e.name === input.name)?.keyVersion ?? 1;
  return api.environments.grantAccess({ keyVersion, ...input });
}

type Api = any;
const PASSWORD = "correct horse battery staple";
let dir: string;
let db: Kysely<Database>;
const handler = new RPCHandler(appRouter);

function client(token?: string, extraHeaders: Record<string, string> = {}, remoteAddress = "10.0.0.1"): Api {
  return createORPCClient(
    new RPCLink({
      url: "http://hub.test/rpc",
      headers: () => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders }),
      fetch: async (request: Request) => {
        const { response } = await handler.handle(request, {
          prefix: "/rpc",
          context: { headers: request.headers, db, remoteAddress },
        });
        return response ?? new Response("nf", { status: 404 });
      },
    }),
  );
}

type User = { username: string; token: string; privateKey: string; publicKey: string; api: Api };

async function signup(username: string, inviteToken?: string, headers?: Record<string, string>): Promise<User> {
  const m = await createAccountMaterial(username, PASSWORD);
  const r = await client(undefined, headers).signup({
    username, authKey: m.authKey, kdf: m.kdf, publicKey: m.publicKey,
    wrappedPrivateKey: m.wrappedPrivateKey,
    recovery: { authKey: m.recovery.recoveryAuthKey, wrappedPrivateKey: m.recovery.recoveryWrappedPrivateKey },
    inviteToken,
  });
  return { username, token: r.token, privateKey: m.privateKey, publicKey: m.publicKey, api: client(r.token) };
}

async function rawLogin(username: string, password = PASSWORD, _unused?: undefined, headers?: Record<string, string>, ip?: string) {
  const c = client(undefined, headers, ip);
  const { kdf } = await c.prelogin({ username });
  const keys = await deriveFromPassword(password, username, kdf);
  return c.login({ username, authKey: keys.authKey });
}

describe("hardening", () => {
  let admin: User;
  const SETUP = "generated-setup-token";

  before(async () => {
    for (const k of ["DATABASE_URL", "ENVVAULT_SIGNUP", "ENVVAULT_ALLOW_SIGNUP", "ENVVAULT_TRUSTED_PROXIES", "ENVVAULT_SETUP_TOKEN"]) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "envvault-hard-"));
    db = await openDb(join(dir, "vault.db"));
  });
  after(() => {
    delete process.env.ENVVAULT_TRUSTED_PROXIES;
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates a setup token for a fresh hub and requires it for the first account", async () => {
    const token = await ensureSetupToken(db);
    assert.ok(token && token.length >= 20, "token generated for the operator's log");
    assert.equal(await ensureSetupToken(db), token, "replicas agree on the same token");
    assert.equal((await client().status()).requiresSetupToken, true);

    await assert.rejects(signup("alice"), /setup token/i);
    await assert.rejects(signup("alice", "wrong-token-value"), /setup token/i);
    admin = await signup("alice", token!);
    assert.equal((await admin.api.me()).role, "admin");
    assert.equal(await ensureSetupToken(db), null, "token is gone once initialised");
    assert.equal((await client().status()).requiresSetupToken, false);
    void SETUP;
  });

  it("ignores X-Forwarded-For unless proxies are trusted", () => {
    const h = new Headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" });
    delete process.env.ENVVAULT_TRUSTED_PROXIES;
    assert.equal(clientIp({ headers: h, remoteAddress: "10.9.9.9" }), "10.9.9.9", "spoofable header ignored");
    process.env.ENVVAULT_TRUSTED_PROXIES = "1";
    assert.equal(clientIp({ headers: h, remoteAddress: "10.9.9.9" }), "1.2.3.4", "last hop = what our proxy saw");
    process.env.ENVVAULT_TRUSTED_PROXIES = "2";
    assert.equal(clientIp({ headers: h, remoteAddress: "10.9.9.9" }), "6.6.6.6");
    delete process.env.ENVVAULT_TRUSTED_PROXIES;
    assert.equal(clientIp({ headers: new Headers({ "cf-connecting-ip": "9.9.9.9" }), trustCloudflare: true }), "9.9.9.9");
    assert.equal(clientIp({ headers: new Headers({ "cf-connecting-ip": "9.9.9.9" }), remoteAddress: "1.1.1.1" }), "1.1.1.1");
  });

  it("forged X-Forwarded-For can't dodge the login limit; per-account throttle spans addresses", async () => {
    // Same real address, a different forged header each time: still counted as one client.
    let blocked = false;
    for (let i = 0; i < 12; i++) {
      try {
        await rawLogin("alice", "wrong password!!", undefined, { "x-forwarded-for": `7.7.7.${i}` }, "10.1.1.1");
      } catch (e: any) {
        if (/Too many/.test(e.message)) { blocked = true; break; }
      }
    }
    assert.ok(blocked, "rate limit tripped despite rotating forged headers");

    // Many different addresses guessing one account: the account itself throttles.
    await db.deleteFrom("rate_limits").execute();
    let acctBlocked = false;
    for (let i = 0; i < 16 && !acctBlocked; i++) {
      try {
        await rawLogin("alice", "wrong password!!", undefined, undefined, `10.2.2.${i}`);
      } catch (e: any) {
        if (/Too many/.test(e.message)) acctBlocked = true;
      }
    }
    assert.ok(acctBlocked, "account throttled across IPs");
    await db.deleteFrom("rate_limits").execute();
    assert.ok((await rawLogin("alice", PASSWORD, undefined, undefined, "10.3.3.3")).token, "legit login works once the window clears");
  });

  it("lists devices and revokes sessions", async () => {
    await db.deleteFrom("rate_limits").execute();
    const s1 = await rawLogin("alice", PASSWORD, undefined, { "user-agent": "TestBrowser/1.0" }, "10.5.5.1");
    const s2 = await rawLogin("alice", PASSWORD, undefined, { "user-agent": "OtherBrowser/2.0" }, "10.5.5.2");
    const list = await client(s2.token).sessions.list();
    assert.ok(list.length >= 2);
    const current = list.filter((x: any) => x.current);
    assert.equal(current.length, 1);
    assert.equal(current[0].userAgent, "OtherBrowser/2.0");
    assert.equal(current[0].ip, "10.5.5.2");

    const other = list.find((x: any) => x.userAgent === "TestBrowser/1.0");
    await client(s2.token).sessions.revoke({ id: other.id });
    await assert.rejects(client(s1.token).me(), /Invalid auth token/);
    await client(s2.token).sessions.revokeOthers();
    assert.equal((await client(s2.token).sessions.list()).length, 1);
  });

  it("flags environments for rotation when someone with the key is removed, until a manager rotates", async () => {
    await db.deleteFrom("rate_limits").execute();
    const a = client((await rawLogin("alice", PASSWORD, undefined, undefined, "10.6.6.1")).token);
    const org = await a.tenants.create({ name: "acme" });
    const inv = await a.admin.invites.create({ expiresInHours: 1, tenantId: org.id });
    const bob = await signup("bob", inv.token);
    await bob.api.tenants.acceptInvite({ tenantId: org.id });

    // alice creates a project and shares its key with bob
    const dek = generateDek();
    const recips = await a.tenants.keyRecipients({ tenantId: org.id });
    await a.projects.create({
      tenantId: org.id, name: "api",
      payload: await sealEnv({ K: "v" }, dek, envAad(org.id, "api", "default")),
      keyWraps: await Promise.all(recips.map(async (r: any) => ({ username: r.username, wrappedEnvDek: await wrapSecretForPublicKey(dek, r.publicKey) }))),
    });
    const bobKey = await a.users.resolve({ username: "bob" });
    await grantAccess(a, {
      tenantId: org.id, project: "api", name: "default", username: "bob", level: "read",
      wrappedEnvDek: await wrapSecretForPublicKey(dek, bobKey.publicKey),
    });

    const removal = await a.tenants.removeMember({ tenantId: org.id, username: "bob" });
    assert.deepEqual(removal.rotate, [{ project: "api", env: "default" }]);
    const listed = await a.environments.list({ tenantId: org.id, project: "api" });
    assert.equal(listed[0].rotatePending, true, "flagged until someone rotates");

    // A manager rotates → flag clears.
    const dek2 = generateDek();
    await a.environments.rotate({
      tenantId: org.id, project: "api", name: "default",
      payload: await sealEnv({ K: "v" }, dek2, envAad(org.id, "api", "default")),
      keyWraps: [{ username: "alice", wrappedEnvDek: await wrapSecretForPublicKey(dek2, admin.publicKey ?? (await a.users.resolve({ username: "alice" })).publicKey) }],
    });
    assert.equal((await a.environments.list({ tenantId: org.id, project: "api" }))[0].rotatePending, false);
  });

  it("detects audit rows edited behind the server's back", async () => {
    const a = client((await rawLogin("alice", PASSWORD, undefined, undefined, "10.7.7.1")).token);
    const clean = await a.admin.audit.verify();
    assert.ok(clean.checked > 5);
    assert.equal(clean.invalid, 0);

    const victim = await db.selectFrom("audit_log").selectAll().where("action", "=", "env.rotate").executeTakeFirstOrThrow().catch(
      () => db.selectFrom("audit_log").selectAll().limit(1).executeTakeFirstOrThrow(),
    );
    await db.updateTable("audit_log").set({ actor: "someone-else" }).where("id", "=", victim.id).execute();
    assert.equal((await a.admin.audit.verify()).invalid, 1);
  });

  it("sends hardening headers; HSTS is opt-in", () => {
    delete process.env.ENVVAULT_HSTS;
    const base = securityHeaders("text/html");
    assert.ok(!base["strict-transport-security"]);
    assert.equal(base["cross-origin-opener-policy"], "same-origin");
    assert.ok(!/googleapis|gstatic/.test(base["content-security-policy"]!), "no third-party hosts");
    process.env.ENVVAULT_HSTS = "true";
    assert.match(securityHeaders("text/html")["strict-transport-security"]!, /max-age=31536000/);
    delete process.env.ENVVAULT_HSTS;
  });
});
