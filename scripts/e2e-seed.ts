/**
 * Local end-to-end fixture for the Kubernetes operator: boots a real hub (SQLite, https),
 * creates a project and a read-only service token, then keeps serving until killed.
 *
 *   ENVVAULT_TLS_CERT=… ENVVAULT_TLS_KEY=… E2E_DIR=<dir> tsx scripts/e2e-seed.ts
 *
 * Writes <dir>/token and <dir>/ready. Not for real use: the data is throwaway.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  createAccountMaterial,
  encodeServiceToken,
  envAad,
  generateDek,
  generateIdentityKeyPair,
  sealEnv,
  wrapSecretForPublicKey,
} from "@envvault/shared";
import { startServer } from "../src/server.js";

const dir = process.env.E2E_DIR!;
const port = Number(process.env.E2E_PORT ?? 38447);
const origin = `https://127.0.0.1:${port}`;
process.env.ENVVAULT_SETUP_TOKEN = "e2e-setup-token";
process.env.ENVVAULT_SIGNUP = "closed";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // this script only talks to its own throwaway hub
mkdirSync(dir, { recursive: true });

await startServer({ port, host: "127.0.0.1", dbTarget: join(dir, "hub.db") });

const api = (token?: string): any =>
  createORPCClient(new RPCLink({ url: `${origin}/rpc`, headers: () => (token ? { authorization: `Bearer ${token}` } : {}) }));

const m = await createAccountMaterial("alice", "correct horse battery staple");
const signedUp = await api().signup({
  username: "alice",
  authKey: m.authKey,
  kdf: m.kdf,
  publicKey: m.publicKey,
  wrappedPrivateKey: m.wrappedPrivateKey,
  recovery: { authKey: m.recovery.recoveryAuthKey, wrappedPrivateKey: m.recovery.recoveryWrappedPrivateKey },
  inviteToken: "e2e-setup-token",
});
const admin = api(signedUp.token);
const tenantId: string = (await admin.tenants.list())[0].id;

const project = "my-app";
const env = "default";
const values = { DATABASE_URL: "postgres://u:p@db/app", API_KEY: "sk_e2e_1", MULTILINE: "a\nb\n" };
const dek = generateDek();
const recipients = await admin.tenants.keyRecipients({ tenantId });
await admin.projects.create({
  tenantId,
  name: project,
  payload: await sealEnv(values, dek, envAad(tenantId, project, env)),
  keyWraps: await Promise.all(
    recipients.map(async (r: any) => ({ username: r.username, wrappedEnvDek: await wrapSecretForPublicKey(dek, r.publicKey) })),
  ),
});

const keys = await generateIdentityKeyPair();
const svc = await admin.serviceAccounts.create({ tenantId, name: "k8s", publicKey: keys.publicKey, expiresInDays: 2 });
const rows = await admin.environments.list({ tenantId, project });
await admin.environments.grantAccess({
  tenantId, project, name: env, username: svc.username, level: "read",
  keyVersion: rows[0].keyVersion,
  wrappedEnvDek: await wrapSecretForPublicKey(dek, keys.publicKey),
});

writeFileSync(join(dir, "token"), encodeServiceToken({ v: 1, u: svc.username, t: svc.token, k: keys.privateKey, w: tenantId, r: origin }), { mode: 0o600 });
writeFileSync(join(dir, "ready"), JSON.stringify({ project, env, values, tenantId, origin }));
console.log("e2e hub ready", origin);
