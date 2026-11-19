import type { Command } from "commander";
import { validateNewPassword } from "@envvault/shared";
import {
  clearSession,
  describeConfigPaths,
  loadConfig,
  requireRemote,
  requireSession,
  resetPins,
  updateConfig,
} from "../config.js";
import { resolveContext } from "../context.js";
import { forgetDeviceKey, persistSession } from "../keystore.js";
import { prepareRemote, probeAndTrust } from "./remote.js";
import { hasRemote, hubListTenants, hubLogin, hubRecover, hubSignup } from "../remote.js";
import { promptLine, promptPassword } from "../cli/prompt.js";
import { c, hint, info, printJson, success } from "../ui.js";
import { DEFAULT_ENV_NAME } from "@envvault/shared";

function reportStorage(mode: "keychain" | "password"): void {
  hint(
    mode === "keychain"
      ? "Your private key is stored encrypted, with its unlock key in the OS keychain."
      : "No OS keychain here: your private key is stored sealed with your password. " +
          "Commands will ask for it (or read ENVVAULT_PASSWORD); use a service token for CI.",
  );
}

/** Read a password from ENVVAULT_PASSWORD or the terminal; `confirm` asks twice. */
async function readPassword(label: string, opts: { confirm?: boolean; what: string }): Promise<string> {
  const fromEnv = process.env.ENVVAULT_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(`Set ENVVAULT_PASSWORD for non-interactive ${opts.what} (don't pass passwords as arguments).`);
  }
  const password = await promptPassword(`${label}: `);
  if (opts.confirm && password !== (await promptPassword("Confirm password: "))) {
    throw new Error("Passwords do not match.");
  }
  if (!password) throw new Error("Password cannot be empty.");
  return password;
}

export function registerAuth(program: Command): void {
  program
    .command("init")
    .description("Set the hub URL and default project (global, or ./.envvault with --local)")
    .option("-r, --remote <url>", "Hub URL (e.g. https://envvault.example.com)")
    .option("-d, --default-project <name>", "Default project name")
    .option("-e, --default-env <name>", "Default environment name", DEFAULT_ENV_NAME)
    .option("-l, --local", "Save to ./.envvault (this directory only); your login stays global")
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const scope = opts.local ? "project" : "global";
      const hub = opts.remote ? prepareRemote(opts.remote as string) : undefined;
      const next = updateConfig(
        {
          ...(hub ? { remote: hub } : {}),
          ...(opts.defaultProject ? { defaultProject: opts.defaultProject as string } : {}),
          ...(opts.defaultEnv ? { defaultEnv: opts.defaultEnv as string } : {}),
        },
        { scope },
      );
      const paths = describeConfigPaths();
      success(`Saved ${scope === "project" ? paths.project : paths.global}`);
      if (next.remote) info(`  Hub: ${next.remote}`);
      if (next.defaultProject) info(`  Default project: ${next.defaultProject}`);
      if (next.defaultEnv) info(`  Default environment: ${next.defaultEnv}`);
      if (hub) await probeAndTrust(hub, opts);
      hint("Next: envvault login <username>");
    });

  program
    .command("login")
    .description("Log in to the hub (the password never leaves this machine)")
    .argument("[username]", "Username (asked if omitted)")
    .action(async (usernameArg: string | undefined) => {
      const config = loadConfig();
      requireRemote(config);
      const username = usernameArg ?? (await promptLine("Username: "));
      if (!username) throw new Error("Username cannot be empty.");
      const password = await readPassword("Password", { what: "login" });
      const session = await hubLogin(config, username, password);
      reportStorage(await persistSession(requireRemote(config), session));
      success(`Logged in as ${c.bold(session.username)}`);
    });

  program
    .command("signup")
    .description("Create an account with an invite code")
    .argument("<username>", "Username")
    .requiredOption("-i, --invite <code>", "Invite code from your administrator (or the first-run setup token)")
    .action(async (username: string, opts) => {
      const config = loadConfig();
      requireRemote(config);
      const password = await readPassword("Choose a password", { confirm: true, what: "signup" });
      const weak = validateNewPassword(password);
      if (weak) throw new Error(weak);
      info("Generating encryption keys…");
      const { session, recoveryKey } = await hubSignup(config, username, password, opts.invite as string);
      reportStorage(await persistSession(requireRemote(config), session));
      success(`Account created. Logged in as ${c.bold(session.username)}\n`);
      info(c.bold("RECOVERY KEY — shown once. Store it somewhere safe (a password manager):\n"));
      info(`    ${recoveryKey}\n`);
      hint("If you forget your password this is the only way back in; the hub cannot reset it.");
    });

  program
    .command("recover")
    .description("Reset a forgotten password with your recovery key")
    .argument("<username>", "Username")
    .option("-k, --recovery-key <key>", "Recovery key (or set ENVVAULT_RECOVERY_KEY)")
    .action(async (username: string, opts) => {
      const config = loadConfig();
      requireRemote(config);
      const recoveryKey = (opts.recoveryKey as string | undefined) ?? process.env.ENVVAULT_RECOVERY_KEY;
      if (!recoveryKey) throw new Error("Pass --recovery-key or set ENVVAULT_RECOVERY_KEY.");
      const password = await readPassword("New password", { confirm: true, what: "recovery" });
      const weak = validateNewPassword(password);
      if (weak) throw new Error(weak);
      const session = await hubRecover(config, username, recoveryKey, password);
      reportStorage(await persistSession(requireRemote(config), session));
      success(`Password reset. Logged in as ${c.bold(session.username)}`);
    });

  program
    .command("logout")
    .description("Clear the saved session and forget the keychain entry")
    .action(async () => {
      const config = loadConfig();
      if (config.session && hasRemote(config)) {
        await forgetDeviceKey(requireRemote(config), config.session.username);
      }
      clearSession();
      success("Logged out.");
    });

  program
    .command("whoami")
    .description("Show who you are, your workspace and where config comes from")
    .option("--json", "Machine-readable output")
    .action(async (opts) => {
      const config = loadConfig();
      const session = requireSession(config);
      const tenants = await hubListTenants(config);
      const active = tenants.find((t) => t.id === session.activeTenantId);
      const ctx = resolveContext({}, config);
      const out = {
        user: session.username,
        workspace: active ? `${active.slug} (${active.kind})` : session.activeTenantId,
        hub: requireRemote(config),
        config: ctx.source?.path ?? null,
        target: ctx.source?.target ?? null,
        project: ctx.project ?? null,
        env: ctx.env,
      };
      if (opts.json) return printJson(out);
      info(`${c.dim("User      ")} ${out.user}`);
      info(`${c.dim("Workspace ")} ${out.workspace}`);
      info(`${c.dim("Hub       ")} ${out.hub}`);
      info(
        `${c.dim("Config    ")} ${out.config ?? `none here (global: ${describeConfigPaths().global})`}` +
          (out.target ? ` → ${out.target}` : ""),
      );
      if (out.project) info(`${c.dim("Acting on ")} ${out.project}/${out.env}`);
    });

  program
    .command("trust")
    .description("Manage remembered public keys")
    .command("reset")
    .description("Forget every remembered public key for this hub (after verifying a real key change)")
    .action(() => {
      resetPins(requireRemote(loadConfig()));
      success("Trusted keys reset.");
    });
}
