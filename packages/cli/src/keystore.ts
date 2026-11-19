import {
  deriveFromPassword,
  importAesKey,
  open,
  openPrivateKey,
  privateKeyAad,
  randomBytes,
  seal,
  toB64Url,
} from "@envvault/shared";
import type { CliSession, StoredKey } from "./config.js";
import { updateConfig } from "./config.js";
import { promptPassword } from "./cli/prompt.js";

/**
 * Where the CLI keeps your decrypted private key:
 *
 *  - **keychain** (default when the OS offers one): the key is sealed on disk with a random
 *    32-byte device key that lives in the OS keychain (macOS Keychain, Windows Credential
 *    Manager, Secret Service on Linux). The config file alone is useless.
 *  - **password** (no keychain, e.g. headless Linux): only the password-sealed copy from the
 *    hub is stored; the password unlocks it per command (prompt, or ENVVAULT_PASSWORD).
 *
 * The decrypted key never touches disk. CI should use service tokens, which live in an
 * environment variable instead.
 */

export type Ring = {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
};

let injected: Ring | null | undefined;
let detected: Ring | null | undefined;

/** Test hook: force a keyring implementation (or `null` for "no keychain"). */
export function __setKeyringForTests(ring: Ring | null | undefined): void {
  injected = ring;
  detected = undefined;
  unlocked.clear();
}

async function ring(): Promise<Ring | null> {
  if (injected !== undefined) return injected;
  if (detected !== undefined) return detected;
  if (process.env.ENVVAULT_KEYCHAIN?.trim().toLowerCase() === "off") return (detected = null);
  try {
    const { Entry } = await import("@napi-rs/keyring");
    // Probe it: headless Linux has the module but no Secret Service to talk to.
    const probe = new Entry("envvault", "__probe__");
    probe.setPassword("probe");
    probe.deletePassword();
    detected = {
      async get(account) {
        return new Entry("envvault", account).getPassword() ?? null;
      },
      async set(account, secret) {
        new Entry("envvault", account).setPassword(secret);
      },
      async delete(account) {
        try {
          new Entry("envvault", account).deletePassword();
        } catch {
          /* already gone */
        }
      },
    };
  } catch {
    detected = null;
  }
  return detected;
}

const account = (remote: string, username: string) => `${remote}|${username.toLowerCase()}`;
const keyAad = (username: string) => `envvault:cli-key:v1|${username.toLowerCase()}`;

/** Decrypted keys cached for this process only; concurrent callers share one unlock (one prompt). */
const unlocked = new Map<string, Promise<string>>();

/** Choose how to keep `privateKey` at rest. Never returns plaintext. */
export async function protectPrivateKey(opts: {
  remote: string;
  username: string;
  privateKey: string;
  passwordKey?: CliSession["passwordKey"];
}): Promise<StoredKey> {
  const r = await ring();
  if (r) {
    try {
      const deviceKey = toB64Url(randomBytes(32));
      await r.set(account(opts.remote, opts.username), deviceKey);
      const sealed = await seal(opts.privateKey, await importAesKey(deviceKey), keyAad(opts.username));
      return { mode: "keychain", sealed };
    } catch {
      /* keychain refused (locked, denied): fall through to the password copy */
    }
  }
  if (!opts.passwordKey) {
    throw new Error(
      "No OS keychain is available and there is no password-sealed key to store. " +
        "Run `envvault login` (or use a service token for CI).",
    );
  }
  return { mode: "password", wrapped: opts.passwordKey.wrapped, kdf: opts.passwordKey.kdf };
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.ENVVAULT_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(
      "This session's key is protected by your password, but no terminal is available. " +
        "Set ENVVAULT_PASSWORD, or use a service token (ENVVAULT_TOKEN) for non-interactive use.",
    );
  }
  return promptPassword("Password (to unlock your key): ");
}

/** The decrypted private key for the stored session (prompting for the password if needed). */
export function unlockPrivateKey(session: CliSession, remote: string): Promise<string> {
  if (session.privateKey) return Promise.resolve(session.privateKey);
  const id = account(remote, session.username);
  let pending = unlocked.get(id);
  if (!pending) {
    pending = doUnlock(session, remote);
    unlocked.set(id, pending);
    pending.catch(() => unlocked.delete(id)); // allow a retry after a wrong password
  }
  return pending;
}

async function doUnlock(session: CliSession, remote: string): Promise<string> {
  const key = session.key;
  if (!key) throw new Error("Not logged in. Run `envvault login <username>`.");

  if (key.mode === "keychain") {
    const r = await ring();
    const deviceKey = r ? await r.get(account(remote, session.username)) : null;
    if (!deviceKey) {
      throw new Error(
        "Your key is stored in the OS keychain, but it isn't available here. Run `envvault login` again.",
      );
    }
    return open(key.sealed, await importAesKey(deviceKey), keyAad(session.username));
  }

  const password = await readPassword();
  const { wrapKey } = await deriveFromPassword(password, session.username, key.kdf);
  try {
    return await openPrivateKey(key.wrapped, wrapKey, session.username);
  } catch {
    throw new Error("Wrong password.");
  }
}

/** Seal + save a freshly authenticated session. Returns where the key went. */
export async function persistSession(
  remote: string,
  session: CliSession,
): Promise<"keychain" | "password"> {
  if (!session.privateKey) throw new Error("Nothing to store: session has no private key.");
  const key = await protectPrivateKey({
    remote,
    username: session.username,
    privateKey: session.privateKey,
    passwordKey: session.passwordKey,
  });
  const { privateKey: _drop, passwordKey: _drop2, ...rest } = session;
  updateConfig({ session: { ...rest, remote: remote.replace(/\/$/, ""), key } });
  return key.mode;
}

export async function forgetDeviceKey(remote: string, username: string): Promise<void> {
  const r = await ring();
  await r?.delete(account(remote, username));
  unlocked.delete(account(remote, username));
}

/**
 * Older versions wrote the decrypted private key to the config file. If we find one and a
 * keychain is available, seal it and rewrite the file without the plaintext.
 * Returns true if a plaintext key remains on disk (no keychain to move it into).
 */
export async function migrateLegacySessionKey(
  remote: string | undefined,
  session: { privateKey?: string; key?: StoredKey } & Partial<CliSession>,
): Promise<"migrated" | "still-plaintext" | "none"> {
  if (!session.privateKey || session.key || !session.username || !remote) return "none";
  const r = await ring();
  if (!r) return "still-plaintext";
  const key = await protectPrivateKey({ remote, username: session.username, privateKey: session.privateKey });
  const { privateKey: _drop, ...rest } = session;
  updateConfig({ session: { ...(rest as CliSession), key } });
  return "migrated";
}
