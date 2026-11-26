/**
 * Drives a running hub for operator tests (throwaway data only). The hub is reached over
 * https and its certificate is not verified, so point it at a test hub, never a real one.
 *
 *   E2E_HUB=https://127.0.0.1:8443 E2E_SETUP_TOKEN=… [E2E_SESSION=<file>] tsx scripts/e2e-driver.ts <command> …
 *
 *   init                         first account (alice)
 *   project <name> K=V …         create a project with a `default` environment
 *   token <svc> <project>…       service account with read (E2E_LEVEL=write for write) on each project's default env; token to stdout
 *   set <project> K=V …          merge values into project/default (what a human does in the dashboard)
 *   get <project>                print project/default decrypted as JSON
 *   list                         service accounts and their state
 *   revoke <svc>                 revoke a service account
 *   k8s-connect <name>           a cluster token (svc-k8s-<name>) with no grants, like the dashboard's "Connect cluster"; token to stdout
 *   k8s-adopt <link id> <on|off>   let a pull link take over a Secret that already exists
 *   k8s-link <project> <cluster> <namespace> <secret> <pull|push> [adopt]   grant the cluster token the key and link, like the dashboard's "Link"
 *   k8s-links <project>          the links on project/default as the hub shows them
 *   k8s-unlink <project> <id>    remove a link
 *   k8s-clusters                 the clusters as the hub shows them
 *   (project arguments take `project:env` for an environment other than `default`)
 *   env-add / env-del <project:env> [K=V…]   create or delete an environment
 *   project-del <project>        delete a project
 *   rotate <project[:env]>       re-key an environment for everyone who holds its key
 *   bulk-links <count> <namespaces> <cluster> [prefix] [pull|push]   <prefix>1..N, each linked to namespace st-<i mod n>, Secret <prefix>-<i>
 *   bulk-edit <count> <value> [prefix]   K0=<value> in <prefix>1..N (default st)
 *   bulk-del <count> [prefix]    delete the projects <prefix>1..N
 *   bulk-count <count> <key> <value> [prefix]   how many of <prefix>1..N hold key=value
 */
import {
  createAccountMaterial,
  decodeServiceToken,
  deriveFromPassword,
  encodeServiceToken,
  envAad,
  generateDek,
  generateIdentityKeyPair,
  openEnv,
  openPrivateKey,
  sealEnv,
  unwrapSecretWithPrivateKey,
  wrapSecretForPublicKey,
  type SealedBox,
} from "@envvault/shared";
import { readFileSync, writeFileSync } from "node:fs";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const origin = process.env.E2E_HUB!;
const PASSWORD = "correct horse battery staple";
const api = (token?: string): any =>
  createORPCClient(new RPCLink({ url: `${origin}/rpc`, headers: () => (token ? { authorization: `Bearer ${token}` } : {}) }));

/** A login is rate limited (8 per 15 min), so the session is kept between commands. */
const SESSION = process.env.E2E_SESSION;

async function login() {
  if (SESSION) {
    try {
      const saved = JSON.parse(readFileSync(SESSION, "utf8"));
      const a = api(saved.token);
      await a.me();
      return { a, privateKey: saved.privateKey as string, tenantId: saved.tenantId as string };
    } catch {
      /* expired or missing: log in again */
    }
  }
  const { kdf } = await api().prelogin({ username: "alice" });
  const keys = await deriveFromPassword(PASSWORD, "alice", kdf);
  const r = await api().login({ username: "alice", authKey: keys.authKey });
  const privateKey = await openPrivateKey(r.wrappedPrivateKey as SealedBox, keys.wrapKey, "alice");
  const a = api(r.token);
  const tenantId: string = (await a.tenants.list())[0].id;
  if (SESSION) writeFileSync(SESSION, JSON.stringify({ token: r.token, privateKey, tenantId }), { mode: 0o600 });
  return { a, privateKey, tenantId };
}

/** K=V pairs; a value that starts with @ is read from that file (for big or awkward values). */
const kv = (args: string[]) =>
  Object.fromEntries(
    args.map((s) => {
      const v = s.slice(s.indexOf("=") + 1);
      return [s.slice(0, s.indexOf("=")), v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v];
    }),
  );

/** `project` or `project:env` (the environment defaults to `default`). */
const loc = (arg: string) => {
  const [project, env = "default"] = arg.split(":");
  return { project: project!, env };
};

async function projectDek(s: Awaited<ReturnType<typeof login>>, project: string, env = "default") {
  const rows = await s.a.environments.list({ tenantId: s.tenantId, project });
  const row = rows.find((e: any) => e.name === env);
  return { dek: await unwrapSecretWithPrivateKey(row.wrappedEnvDek, s.privateKey), row };
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "init") {
  const m = await createAccountMaterial("alice", PASSWORD);
  await api().signup({
    username: "alice", authKey: m.authKey, kdf: m.kdf, publicKey: m.publicKey, wrappedPrivateKey: m.wrappedPrivateKey,
    recovery: { authKey: m.recovery.recoveryAuthKey, wrappedPrivateKey: m.recovery.recoveryWrappedPrivateKey },
    inviteToken: process.env.E2E_SETUP_TOKEN,
  });
  console.log("alice created");
} else if (cmd === "project") {
  const s = await login();
  const [name, ...pairs] = args;
  const dek = generateDek();
  const recipients = await s.a.tenants.keyRecipients({ tenantId: s.tenantId });
  await s.a.projects.create({
    tenantId: s.tenantId, name,
    payload: await sealEnv(kv(pairs), dek, envAad(s.tenantId, name, "default")),
    keyWraps: await Promise.all(recipients.map(async (r: any) => ({ username: r.username, wrappedEnvDek: await wrapSecretForPublicKey(dek, r.publicKey) }))),
  });
  console.log(`project ${name} created`);
} else if (cmd === "token") {
  const s = await login();
  const [svcName, ...projects] = args;
  const keys = await generateIdentityKeyPair();
  const svc = await s.a.serviceAccounts.create({ tenantId: s.tenantId, name: svcName, publicKey: keys.publicKey, expiresInDays: Number(process.env.E2E_DAYS ?? 7) });
  for (const project of projects) {
    const { dek, row } = await projectDek(s, project);
    await s.a.environments.grantAccess({
      tenantId: s.tenantId, project, name: "default", username: svc.username, level: process.env.E2E_LEVEL ?? "read",
      keyVersion: row.keyVersion, wrappedEnvDek: await wrapSecretForPublicKey(dek, keys.publicKey),
    });
  }
  process.stdout.write(encodeServiceToken({ v: 1, u: svc.username, t: svc.token, k: keys.privateKey, w: s.tenantId, r: origin }));
} else if (cmd === "set") {
  const s = await login();
  const [target, ...pairs] = args;
  const { project, env } = loc(target!);
  const { dek } = await projectDek(s, project, env);
  const got = await s.a.environments.getEnv({ tenantId: s.tenantId, project, name: env });
  const current = await openEnv(got.payload, dek, envAad(s.tenantId, project, env));
  const next = { ...current, ...kv(pairs) };
  const saved = await s.a.environments.saveEnv({
    tenantId: s.tenantId, project, name: env, baseUpdatedAt: got.updatedAt,
    payload: await sealEnv(next, dek, envAad(s.tenantId, project, env)),
  });
  console.log(`saved ${project} at ${saved.updatedAt}`);
} else if (cmd === "get") {
  const s = await login();
  const { project, env } = loc(args[0]!);
  const { dek } = await projectDek(s, project, env);
  const got = await s.a.environments.getEnv({ tenantId: s.tenantId, project, name: env });
  console.log(JSON.stringify(await openEnv(got.payload, dek, envAad(s.tenantId, project, env))));
} else if (cmd === "env-add") {
  const s = await login();
  const [target, ...pairs] = args;
  const { project, env } = loc(target!);
  const dek = generateDek();
  const recipients = await s.a.tenants.keyRecipients({ tenantId: s.tenantId });
  await s.a.environments.create({
    tenantId: s.tenantId, project, name: env,
    payload: await sealEnv(kv(pairs), dek, envAad(s.tenantId, project, env)),
    keyWraps: await Promise.all(recipients.map(async (r: any) => ({ username: r.username, wrappedEnvDek: await wrapSecretForPublicKey(dek, r.publicKey) }))),
  });
  console.log(`environment ${project}:${env} created`);
} else if (cmd === "env-del") {
  const s = await login();
  const { project, env } = loc(args[0]!);
  await s.a.environments.delete({ tenantId: s.tenantId, project, name: env });
  console.log(`environment ${project}:${env} deleted`);
} else if (cmd === "project-del") {
  const s = await login();
  await s.a.projects.delete({ tenantId: s.tenantId, name: args[0] });
  console.log(`project ${args[0]} deleted`);
} else if (cmd === "rotate") {
  // Re-key like the dashboard: a fresh key for everyone who holds one now (cluster tokens included).
  const s = await login();
  const { project, env } = loc(args[0]!);
  const { dek } = await projectDek(s, project, env);
  const here = { tenantId: s.tenantId, project, name: env };
  const got = await s.a.environments.getEnv(here);
  const current = await openEnv(got.payload, dek, envAad(s.tenantId, project, env));
  const acl = await s.a.environments.listAccess(here);
  const fresh = generateDek();
  const keyWraps = await Promise.all(acl.map(async (a: any) => ({
    username: a.username, wrappedEnvDek: await wrapSecretForPublicKey(fresh, (await s.a.users.resolve({ username: a.username })).publicKey),
  })));
  await s.a.environments.rotate({ ...here, baseUpdatedAt: got.updatedAt, payload: await sealEnv(current, fresh, envAad(s.tenantId, project, env)), keyWraps });
  console.log(`rotated ${project}:${env} for ${acl.map((a: any) => a.username).join(",")}`);
} else if (cmd === "bulk-links") {
  // <count> <namespaces> <cluster> [prefix=st] [pull|push]: <prefix>1..N, each linked to namespace st-<i mod namespaces>, Secret <prefix>-<i>.
  const s = await login();
  const [count, nsCount, cluster] = [Number(args[0]), Number(args[1]), args[2]!];
  const prefix = args[3] ?? "st";
  const direction = (args[4] ?? "pull") as "pull" | "push";
  const recipients = await s.a.tenants.keyRecipients({ tenantId: s.tenantId });
  const { publicKey } = await s.a.users.resolve({ username: cluster });
  const started = Date.now();
  let next = 1;
  const worker = async () => {
    for (let i = next++; i <= count; i = next++) {
      const project = `${prefix}${i}`;
      const dek = generateDek();
      await s.a.projects.create({
        tenantId: s.tenantId, name: project,
        payload: await sealEnv({ K0: `v0-${i}`, K1: `v1-${i}`, K2: `v2-${i}` }, dek, envAad(s.tenantId, project, "default")),
        keyWraps: await Promise.all(recipients.map(async (r: any) => ({ username: r.username, wrappedEnvDek: await wrapSecretForPublicKey(dek, r.publicKey) }))),
      });
      const row = (await s.a.environments.list({ tenantId: s.tenantId, project })).find((e: any) => e.name === "default");
      await s.a.environments.grantAccess({
        tenantId: s.tenantId, project, name: "default", username: cluster, level: direction === "push" ? "write" : "read",
        keyVersion: row.keyVersion, wrappedEnvDek: await wrapSecretForPublicKey(dek, publicKey),
      });
      await s.a.k8s.links.create({ tenantId: s.tenantId, project, name: "default", cluster, namespace: `st-${i % nsCount}`, secretName: `${prefix}-${i}`, direction });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`${count} projects linked in ${Math.round((Date.now() - started) / 1000)}s`);
} else if (cmd === "bulk-edit") {
  // <count> <value> [prefix=st]: K0=<value> in <prefix>1..N.
  const s = await login();
  const [count, value] = [Number(args[0]), args[1]!];
  const prefix = args[2] ?? "st";
  const started = Date.now();
  let next = 1;
  const worker = async () => {
    for (let i = next++; i <= count; i = next++) {
      const project = `${prefix}${i}`;
      // A hub that is restarting is waited for, so every edit lands.
      for (let attempt = 1; ; attempt++) {
        try {
          const { dek } = await projectDek(s, project);
          const got = await s.a.environments.getEnv({ tenantId: s.tenantId, project, name: "default" });
          const current = await openEnv(got.payload, dek, envAad(s.tenantId, project, "default"));
          await s.a.environments.saveEnv({
            tenantId: s.tenantId, project, name: "default", baseUpdatedAt: got.updatedAt,
            payload: await sealEnv({ ...current, K0: value }, dek, envAad(s.tenantId, project, "default")),
          });
          break;
        } catch (err) {
          if (attempt >= 60) throw err;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`${count} environments edited in ${Math.round((Date.now() - started) / 1000)}s`);
} else if (cmd === "bulk-count") {
  // <count> <key> <value> [prefix=st]: how many of <prefix>1..N hold key=value ({i} in the value stands for N).
  const s = await login();
  const [count, key, value] = [Number(args[0]), args[1]!, args[2]!];
  const prefix = args[3] ?? "st";
  let hit = 0;
  let next = 1;
  const worker = async () => {
    for (let i = next++; i <= count; i = next++) {
      const project = `${prefix}${i}`;
      const { dek } = await projectDek(s, project);
      const got = await s.a.environments.getEnv({ tenantId: s.tenantId, project, name: "default" });
      if ((await openEnv(got.payload, dek, envAad(s.tenantId, project, "default")))[key] === value.replace("{i}", String(i))) hit++;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(hit);
} else if (cmd === "bulk-del") {
  // <count> [prefix=st]: delete the projects <prefix>1..N.
  const s = await login();
  const count = Number(args[0]);
  const prefix = args[1] ?? "st";
  let next = 1;
  const worker = async () => {
    for (let i = next++; i <= count; i = next++) await s.a.projects.delete({ tenantId: s.tenantId, name: `${prefix}${i}` });
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`${count} projects deleted`);
} else if (cmd === "k8s-connect") {
  const s = await login();
  const keys = await generateIdentityKeyPair();
  const svc = await s.a.serviceAccounts.create({ tenantId: s.tenantId, name: `k8s-${args[0]}`, publicKey: keys.publicKey, expiresInDays: 365 });
  process.stdout.write(encodeServiceToken({ v: 1, u: svc.username, t: svc.token, k: keys.privateKey, w: s.tenantId, r: origin }));
} else if (cmd === "agent") {
  // <token file> sync <ns,ns> | report <link id> <status> [message]: stands in for the operator,
  // for looking at the dashboard without a cluster.
  const [file, what, a1, a2, a3] = args;
  const token = decodeServiceToken(readFileSync(file!, "utf8").trim());
  const agent = api(token.t);
  if (what === "sync") {
    const links = await agent.k8s.agent.sync({ version: "0.2.0", namespaces: (a1 ?? "").split(",").filter(Boolean) });
    for (const l of links) console.log(JSON.stringify(l));
  } else {
    await agent.k8s.agent.report({ reports: [{ id: a1, status: a2, message: a3 ?? "", keyCount: 2 }] });
    console.log("reported");
  }
} else if (cmd === "access") {
  // <project> [env]: who holds what on the environment (two arguments, so a project name may hold a colon).
  const s = await login();
  const project = args[0]!;
  const env = args[1] ?? "default";
  for (const a of await s.a.environments.listAccess({ tenantId: s.tenantId, project, name: env })) console.log(JSON.stringify({ username: a.username, level: a.level }));
} else if (cmd === "k8s-link") {
  const s = await login();
  const [target, cluster, namespace, secretName, direction, takeOver] = args;
  const { project, env } = loc(target!);
  const { dek, row } = await projectDek(s, project, env);
  const { publicKey } = await s.a.users.resolve({ username: cluster });
  await s.a.environments.grantAccess({
    tenantId: s.tenantId, project, name: env, username: cluster, level: direction === "push" ? "write" : "read",
    keyVersion: row.keyVersion, wrappedEnvDek: await wrapSecretForPublicKey(dek, publicKey),
  });
  const link = await s.a.k8s.links.create({ tenantId: s.tenantId, project, name: env, cluster, namespace, secretName, direction: direction as "pull" | "push", adopt: takeOver === "adopt" });
  console.log(JSON.stringify({ id: link.id }));
} else if (cmd === "k8s-links") {
  const s = await login();
  const { project, env } = loc(args[0]!);
  for (const l of await s.a.k8s.links.list({ tenantId: s.tenantId, project, name: env })) console.log(JSON.stringify(l));
} else if (cmd === "k8s-adopt") {
  // <link id> <on|off>: let a pull link take over a Secret that already exists (or stop).
  const s = await login();
  console.log(JSON.stringify(await s.a.k8s.links.adopt({ tenantId: s.tenantId, id: args[0]!, adopt: args[1] !== "off" })));
} else if (cmd === "k8s-unlink") {
  const s = await login();
  console.log(JSON.stringify(await s.a.k8s.links.delete({ tenantId: s.tenantId, id: args[1] })));
} else if (cmd === "k8s-clusters") {
  const s = await login();
  for (const c of await s.a.k8s.clusters.list({ tenantId: s.tenantId })) console.log(JSON.stringify(c));
} else if (cmd === "list") {
  const s = await login();
  for (const a of await s.a.serviceAccounts.list({ tenantId: s.tenantId })) console.log(JSON.stringify(a));
} else if (cmd === "revoke") {
  const s = await login();
  const r = await s.a.serviceAccounts.revoke({ tenantId: s.tenantId, username: args[0] });
  console.log("revoked; rotate:", JSON.stringify(r.rotate));
} else {
  console.error("unknown command");
  process.exit(2);
}
