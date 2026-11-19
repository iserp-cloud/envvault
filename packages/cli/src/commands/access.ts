import type { Command } from "commander";
import {
  ACL_CAPS,
  CAP_LABELS,
  describeAccess,
  isAclCap,
  normalizeGrant,
  type AclCap,
  type AclLevel,
} from "@envvault/shared";
import { hubGrantAccess, hubListAccess, hubRotate, type PreparedKey } from "../ops.js";
import { confirmAction } from "../cli/prompt.js";
import { asTarget, resolveTarget, withTarget } from "../cli/target.js";
import { c, hint, info, plural, printJson, printTable, success, warn } from "../ui.js";

type Opts = {
  project?: string;
  env?: string;
  tenant?: string;
  json?: boolean;
  yes?: boolean;
  level?: string;
  allow?: string;
};

const LEVELS: Record<string, AclLevel> = { read: "read", write: "write", manager: "manage", manage: "manage" };

function parseLevel(raw: string | undefined): AclLevel {
  const level = LEVELS[(raw ?? "read").toLowerCase()];
  if (!level) throw new Error(`Level must be read, write or manager (got "${raw}").`);
  return level;
}

function parseCaps(raw: string | undefined): AclCap[] {
  if (!raw) return [];
  const names = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = names.filter((n) => !isAclCap(n));
  if (bad.length) throw new Error(`Unknown permission "${bad.join(", ")}". Choose from: ${ACL_CAPS.join(", ")}.`);
  return names as AclCap[];
}

async function trustPrompt(prepared: PreparedKey, yes: boolean | undefined): Promise<boolean> {
  if (prepared.status === "changed") {
    warn(`${c.bold(prepared.username)}'s public key has CHANGED since you last saw it.`);
    info(`  New fingerprint: ${prepared.display}`);
    hint("This may be a legitimate account reset, or the server substituting a key.");
    // A changed key is never accepted by --yes: it has to be a deliberate, interactive decision.
    return confirmAction("Only continue if they confirm this exact fingerprint. Trust the new key?");
  }
  info(`First time sharing with ${c.bold(prepared.username)}. Their key fingerprint:`);
  info(`  ${prepared.display}`);
  hint("Ask them to check it matches (dashboard: account menu → Key fingerprint).");
  return confirmAction("Trust this key and share?", yes);
}

export function registerAccess(program: Command): void {
  const access = program
    .command("access")
    .description("See who can open an environment, and grant or revoke access");

  withTarget(access.command("list").alias("ls").description("Who has access, and what they may do"))
    .option("--json", "Machine-readable output")
    .action(async (opts: Opts) => {
      const t = await resolveTarget(opts);
      const entries = await hubListAccess(asTarget(t));
      if (opts.json) return printJson(entries);
      info(c.bold(`${t.project}/${t.env}`));
      printTable(
        ["USER", "ACCESS"],
        entries.map((e) => [e.username, describeAccess(e.level, e.caps)]),
      );
    });

  withTarget(
    access
      .command("grant")
      .description("Give someone access, or change what they have")
      .argument("<username>", "Member of the workspace")
      .option("-l, --level <level>", "read, write or manager", "read")
      .option(
        "-a, --allow <list>",
        `Extra permissions, comma-separated: ${ACL_CAPS.map((k) => `${k} (${CAP_LABELS[k].toLowerCase()})`).join(", ")}`,
      )
      .option("-y, --yes", "Accept a first-time public key without asking"),
  ).action(async (username: string, opts: Opts) => {
    const grant = normalizeGrant(parseLevel(opts.level), parseCaps(opts.allow));
    const t = await resolveTarget(opts);
    const done = await hubGrantAccess(asTarget(t), username, grant.level, grant.caps, (p) => trustPrompt(p, opts.yes));
    if (!done) return info("Cancelled.");
    success(
      `${c.bold(username)} now has ${c.bold(describeAccess(grant.level, grant.caps))} on ${t.project}/${t.env}`,
    );
  });

  withTarget(
    access
      .command("revoke")
      .description("Take someone's access away (re-keys the environment)")
      .argument("<username>", "Person to remove")
      .option("-y, --yes", "Skip the confirmation"),
  ).action(async (username: string, opts: Opts) => {
    const t = await resolveTarget(opts);
    const ok = await confirmAction(
      `Revoke ${username}'s access to ${t.project}/${t.env}? This re-keys the environment for everyone else.`,
      opts.yes,
    );
    if (!ok) return info("Cancelled.");
    const r = await hubRotate(asTarget(t), [username]);
    success(`Revoked ${c.bold(username)} and re-keyed ${c.bold(`${t.project}/${t.env}`)} for ${plural(r.kept.length, "person", "people")}`);
    hint("They may still know the old values. Change any secret they could read.");
  });
}
