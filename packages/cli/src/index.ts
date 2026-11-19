import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerCommands } from "./cli/register.js";
import { applyTlsPolicy, loadConfig, loadGlobalConfig, setRemoteFlag } from "./config.js";
import { migrateLegacySessionKey } from "./keystore.js";
import { redactSecrets } from "@envvault/shared";
import { c, messageOf } from "./ui.js";

const program = new Command();

program
  .name("envvault")
  .description("EnvVault CLI: sync env vars with your hub, end-to-end encrypted")
  .version(pkg.version)
  .option("--remote <url>", "Use this hub for this command (overrides config and ENVVAULT_REMOTE)")
  .option("--insecure", "Don't verify the hub's TLS certificate for this command (private networks only)")
  .option("--debug", "Show stack traces for errors")
  .hook("preAction", (_program, action) => {
    const opts = action.optsWithGlobals();
    if (opts.remote) setRemoteFlag(opts.remote as string);
    let remote = process.env.ENVVAULT_REMOTE?.trim();
    try {
      remote ??= loadConfig().remote;
    } catch {
      /* the command itself reports a broken config */
    }
    applyTlsPolicy({ flag: Boolean(opts.insecure), remote });
  })
  .showHelpAfterError("(run with --help for usage)")
  .showSuggestionAfterError()
  .addHelpText(
    "after",
    `
${c.bold("Config")}
  A directory can carry an envvault.toml (or envvault.json) naming its project, environment
  and files. The CLI finds the nearest one in this or a parent directory, so inside such a
  directory plain \`envvault pull\` / \`envvault push\` need no flags, and from the folder that
  holds it they sync every target. Flags always win.

${c.bold("Hub")}
  The CLI talks to whichever hub you point it at: \`envvault remote set <url>\` saves one,
  \`--remote <url>\` or ENVVAULT_REMOTE overrides it for one command, and an envvault.toml's
  \`remote\` applies inside that directory. A login belongs to the hub it was made on.

${c.bold("Examples")}
  envvault remote set https://envvault.example.com   Point the CLI at your server
  envvault login alice               Log in (the password never leaves this machine)
  envvault pull                      Download .env for the project in ./envvault.toml
  envvault set API_URL=https://x.io  Change one value
  envvault history                   See earlier versions, then \`history restore 3\`
  envvault access grant bob -l write -a delete
                                     Let bob read, write and delete (not share or re-key)
  envvault access revoke bob         Remove bob and re-key the environment
  envvault tree init                 Start an envvault.toml for a monorepo
`,
  );

registerCommands(program);

/** Older versions stored the decrypted key in the config file; move it into protected storage. */
async function secureLegacySession(): Promise<void> {
  try {
    const global = loadGlobalConfig();
    if (!global.session) return;
    const remote = (process.env.ENVVAULT_REMOTE ?? global.remote)?.replace(/\/$/, "");
    const result = await migrateLegacySessionKey(remote, global.session);
    if (result === "migrated") {
      console.error("Moved your saved private key out of the config file into protected storage.");
    } else if (result === "still-plaintext") {
      console.error(
        "WARNING: your private key is stored unencrypted in the config file and no OS keychain is available. " +
          "Run `envvault login` to replace it with a password-sealed copy.",
      );
    }
  } catch {
    /* never block a command on migration */
  }
}

/** A short fix-it line for errors people hit often. */
function hintFor(message: string): string | undefined {
  if (/invalid auth token|missing auth token|unauthorized/i.test(message)) {
    return "Your session expired or was revoked. Run `envvault login`.";
  }
  if (/not logged in/i.test(message)) return "Run `envvault login <username>`.";
  if (/too many attempts/i.test(message)) return "Wait a few minutes and try again.";
  if (/changed by someone else/i.test(message)) return "Pull the latest and try again.";
  return undefined;
}

secureLegacySession()
  .then(() => program.parseAsync(process.argv))
  .catch((err) => {
    const message = messageOf(err);
    console.error(`${c.red("error:")} ${message}`);
    const tip = hintFor(message);
    if (tip) console.error(c.dim(tip));
    if (process.argv.includes("--debug") && err instanceof Error && err.stack) console.error(c.dim(redactSecrets(err.stack)));
    process.exit(1);
  });
