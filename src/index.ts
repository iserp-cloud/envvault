#!/usr/bin/env node
/**
 * Monorepo hub entry — local `serve` only.
 * Published CLI lives in packages/cli (`envvault` on npm).
 */
import { Command } from "commander";
import { resolveDbTarget } from "./config.js";
import { openDb } from "./db/index.js";
import { describeTarget, peekSchemaVersion, SCHEMA_VERSION } from "./db/status.js";
import { startServer } from "./server.js";

const program = new Command();

program
  .name("envvault-hub")
  .description("EnvVault hub (local Node server)")
  .version("1.0.0");

program
  .command("serve")
  .description("Start the local hub server (Node)")
  .option("-p, --port <port>", "Port", "3847")
  .option("--host <host>", "Host", "127.0.0.1")
  .action(async (opts) => {
    await startServer({
      port: Number(opts.port),
      host: opts.host as string,
    });
  });

/** The driver's message, plus what usually causes it. */
function connectionHint(err: unknown): string {
  const e = err as { message?: string; code?: string };
  const message = e?.message ?? String(err);
  if (e?.code === "28P01" || /password authentication failed|SASL|client password must be a string/i.test(message)) {
    return (
      `${message}\n` +
      "  Check the user and password in the URL above. A password with special characters must be " +
      "percent-encoded there (@ → %40, # → %23, / → %2F, : → %3A, ? → %3F, % → %25).\n" +
      "  And paste it with `read -rs DATABASE_URL`: without -r the shell eats backslashes."
    );
  }
  if (e?.code === "28000" || /no pg_hba.conf entry/i.test(message)) {
    return `${message}\n  The server has no rule letting this machine in (pg_hba.conf), or it wants SSL: try sslmode=require.`;
  }
  return message;
}

program
  .command("migrate")
  .description("Bring the database schema up to date (the hub also does this when it starts)")
  .option("--check", "Only report whether a migration is pending; exit 1 if it is")
  .action(async (opts) => {
    const target = resolveDbTarget();
    console.log(`Database  ${describeTarget(target)}`);
    const before = await peekSchemaVersion(target).catch((err: unknown) => {
      throw new Error(`Could not connect: ${connectionHint(err)}`);
    });
    console.log(`Schema    ${before ?? "not set up"}  (this hub expects ${SCHEMA_VERSION})`);
    if (before === SCHEMA_VERSION) {
      console.log("Up to date.");
      return;
    }
    if (opts.check) {
      console.log("Migration pending. Run `migrate` without --check to apply it.");
      process.exitCode = 1;
      return;
    }
    const db = await openDb(target); // opening a database brings its schema up to date
    await db.destroy();
    console.log(`Migrated to ${SCHEMA_VERSION}.`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
