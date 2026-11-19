import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { redactSecrets } from "@envvault/shared";
import {
  applyTlsPolicy,
  canTrustCertificates,
  forgetTrustedCert,
  getTrustedCert,
  isLoopback,
  loadConfig,
  normalizeRemote,
  remoteSource,
  saveTrustedCert,
  tlsState,
  updateConfig,
} from "../config.js";
import { describeCert, fetchPeerCert, normalizeFingerprint } from "../trust.js";
import { c, hint, info, isUntrustedCertError, messageOf, printJson, success, warn } from "../ui.js";

/** Ask a hub whether it is alive. Never throws: the answer is the result. */
export async function checkHub(remote: string): Promise<{ ok: boolean; detail: string; untrustedCert?: boolean }> {
  for (const path of ["/healthz", "/health"]) {
    try {
      const res = await fetch(`${remote}${path}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return { ok: true, detail: `reachable (${path})` };
    } catch (err) {
      return { ok: false, detail: messageOf(err), untrustedCert: isUntrustedCertError(err) };
    }
  }
  return { ok: false, detail: "answered, but not like an EnvVault hub (no /healthz or /health)" };
}

type TrustFlags = { fingerprint?: string; ca?: string; verify?: boolean };

/** The fingerprint the user said to expect, as a normal value; throws on something that isn't one. */
function expectedFingerprint(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const fp = normalizeFingerprint(input);
  if (!fp) throw new Error("--fingerprint must be a SHA-256 value, e.g. AA:BB:… (the hub prints it at startup).");
  return fp;
}

/**
 * A hub with a self-made certificate: remember that exact certificate (like SSH does for a new
 * server), so later connections are verified against it and a different certificate is refused.
 * A certificate signed by an authority this computer doesn't know can't be pinned; that needs
 * the authority itself (`--ca`). Returns whether something was saved.
 */
async function trustFirstContact(hub: string, expected: string | undefined): Promise<boolean> {
  if (!canTrustCertificates()) {
    warn("This Node.js can't remember certificates (needs 22.19+). Use the hub's certificate through NODE_EXTRA_CA_CERTS=/path/to/tls.crt instead.");
    return false;
  }
  const peer = await fetchPeerCert(hub);
  if (!peer) return false; // unreachable: the check below reports why
  if (expected && peer.fingerprint !== expected) {
    throw new Error(`The hub's certificate fingerprint is ${peer.fingerprint}, not the ${expected} you gave. Nothing was trusted.`);
  }
  if (!peer.selfSigned) {
    warn(`${hub} presents a certificate signed by an authority this computer doesn't know.`);
    hint("Trust that authority: envvault remote set <url> --ca /path/to/ca.crt   (or NODE_EXTRA_CA_CERTS=/path/to/ca.crt)");
    return false;
  }
  saveTrustedCert(hub, { kind: "pinned", pem: peer.pem, fingerprint: peer.fingerprint });
  applyTlsPolicy({ remote: hub });
  if (expected) {
    info(`  certificate matches the fingerprint you gave (${peer.fingerprint})`);
  } else {
    warn(`Trusting ${hub}'s self-made certificate from now on.`);
    info(`  fingerprint ${c.bold(peer.fingerprint)} (the hub prints the same at startup)`);
    hint("If it ever changes, the CLI refuses to connect until you run `envvault remote trust`.");
  }
  return true;
}

/** Save the certificate authority a hub's certificate is signed by, for that hub only. */
function trustAuthority(hub: string, file: string): void {
  let pem: string;
  try {
    pem = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Cannot read ${file}.`);
  }
  let cert;
  try {
    cert = describeCert(pem);
  } catch {
    throw new Error(`${file} isn't a PEM certificate.`);
  }
  if (!canTrustCertificates()) {
    throw new Error("This Node.js can't remember certificates (needs 22.19+). Set NODE_EXTRA_CA_CERTS to this file instead.");
  }
  saveTrustedCert(hub, { kind: "ca", pem, fingerprint: cert.fingerprint });
  applyTlsPolicy({ remote: hub });
  info(`  trusting ${file} for this hub (${cert.fingerprint})`);
}

/**
 * Check a hub that was just saved. An untrusted self-made certificate is remembered with a notice,
 * and anything else (unreachable, wrong address) is reported without blocking the save.
 */
export async function probeAndTrust(hub: string, flags: TrustFlags = {}): Promise<void> {
  const expected = expectedFingerprint(flags.fingerprint);
  let health = await checkHub(hub);
  if (!health.ok && health.untrustedCert && !flags.verify && !tlsState().insecure) {
    if (await trustFirstContact(hub, expected)) health = await checkHub(hub);
  }
  if (health.ok) info(`  ${health.detail}`);
  else warn(`Saved, but ${hub} isn't answering yet: ${health.detail}`);
}

/** Normalise a URL for saving and warn about anything risky; throws on a malformed one. */
export function prepareRemote(input: string): string {
  const remote = normalizeRemote(input);
  if (remote.startsWith("http://") && !isLoopback(remote)) {
    warn(`${remote} is plain http: your login token would travel unencrypted. Use https:// for a real server.`);
  }
  return remote;
}

export function registerRemote(program: Command): void {
  const remote = program
    .command("remote")
    .description("Show or change which hub (server) the CLI talks to")
    .option("--json", "Machine-readable output")
    .action(async (opts) => {
      const config = loadConfig();
      const src = remoteSource();
      if (src.url) src.url = redactSecrets(src.url);
      const out = {
        hub: src.url ?? null,
        from: src.from,
        certificate: tlsState().insecure ? "not checked" : (tlsState().trusted ?? null),
        loggedInAs: config.session?.username ?? null,
        loginIsForOtherHub: config.otherHub ?? null,
      };
      if (opts.json) return printJson(out);
      if (!src.url) {
        info("No hub set.");
        hint("Point the CLI at your server: envvault remote set https://your-hub.example.com");
        return;
      }
      info(`${c.dim("Hub      ")} ${src.url}`);
      info(`${c.dim("Set by   ")} ${src.from}`);
      const tlsNow = tlsState();
      if (tlsNow.insecure) info(`${c.dim("TLS      ")} ${c.yellow("certificate not checked")} (--insecure / ENVVAULT_INSECURE)`);
      else if (tlsNow.trusted) {
        const what = tlsNow.trusted.kind === "ca" ? "trusted authority" : "trusted certificate";
        info(`${c.dim("TLS      ")} ${what} ${tlsNow.trusted.fingerprint}`);
      }
      info(
        `${c.dim("Login    ")} ${
          config.session
            ? config.session.username
            : config.otherHub
              ? `none here (saved login is for ${config.otherHub})`
              : "not logged in"
        }`,
      );
      hint("Change it: envvault remote set <url>   ·   Test it: envvault remote check");
    });

  remote
    .command("set")
    .description("Point the CLI at a hub (saved globally, or in ./.envvault with --local)")
    .argument("<url>", "Hub URL, e.g. https://envvault.example.com or http://localhost:8787")
    .option("-l, --local", "Save to ./.envvault (this directory only)")
    .option("--ca <file>", "Trust this certificate authority for the hub (its certificate is signed by your own CA)")
    .option("--fingerprint <sha256>", "Only trust a self-made certificate with this fingerprint (for scripts)")
    .option("--verify", "Forget any certificate trusted for this hub and verify it normally")
    .action(async (url: string, _opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      if (opts.verify && (opts.ca || opts.fingerprint)) throw new Error("--verify can't be combined with --ca or --fingerprint.");
      const hub = prepareRemote(url);
      updateConfig({ remote: hub }, { scope: opts.local ? "project" : "global" });
      if (opts.verify) forgetTrustedCert(hub);
      if (opts.ca) trustAuthority(hub, opts.ca as string);
      applyTlsPolicy({ flag: Boolean(opts.insecure), remote: hub });
      success(`Hub set to ${c.bold(hub)}${opts.local ? " for this directory" : ""}`);
      await probeAndTrust(hub, opts);
      hint("Next: envvault login <username>   (an account on another hub won't carry over)");
    });

  remote
    .command("trust")
    .description("Trust the certificate the hub presents now (after you renewed it on purpose)")
    .option("--fingerprint <sha256>", "Only accept a certificate with this fingerprint")
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const hub = remoteSource().url;
      if (!hub) throw new Error("No hub set. Run `envvault remote set <url>` first.");
      if (!hub.startsWith("https://")) throw new Error("This hub isn't https, so there is no certificate to trust.");
      if (!canTrustCertificates()) throw new Error("This Node.js can't remember certificates (needs 22.19+).");
      const expected = expectedFingerprint(opts.fingerprint as string | undefined);
      const peer = await fetchPeerCert(hub);
      if (!peer) throw new Error(`Could not read a certificate from ${hub}. Is it running?`);
      if (expected && peer.fingerprint !== expected) {
        throw new Error(`The hub's certificate fingerprint is ${peer.fingerprint}, not the ${expected} you gave. Nothing was trusted.`);
      }
      if (!peer.selfSigned) {
        throw new Error("That certificate is signed by an authority. Trust the authority instead: envvault remote set <url> --ca ca.crt");
      }
      const old = getTrustedCert(hub);
      if (old?.fingerprint === peer.fingerprint) return info("Already trusted: that is the certificate you trusted before.");
      saveTrustedCert(hub, { kind: "pinned", pem: peer.pem, fingerprint: peer.fingerprint });
      applyTlsPolicy({ remote: hub });
      success(`Trusting the certificate ${hub} presents now.`);
      if (old) info(`  was  ${old.fingerprint}`);
      info(`  now  ${c.bold(peer.fingerprint)} (compare with the hub's startup log)`);
    });

  remote
    .command("check")
    .description("Test that a hub is reachable (the current one by default)")
    .argument("[url]", "Hub URL to test")
    .action(async (url: string | undefined) => {
      const target = url ? normalizeRemote(url) : remoteSource().url;
      if (!target) throw new Error("No hub set. Pass a URL, or run `envvault remote set <url>`.");
      applyTlsPolicy({ flag: tlsState().insecure, remote: target });
      const health = await checkHub(target);
      if (!health.ok) {
        warn(`${target}: ${health.detail}`);
        process.exitCode = 1;
        return;
      }
      success(`${target} ${health.detail}`);
    });
}
