import type { Command } from "commander";
import { hubRotate } from "../ops.js";
import { asTarget, resolveTarget, withTarget } from "../cli/target.js";
import { c, hint, plural, success, warn } from "../ui.js";

type Opts = { project?: string; env?: string; tenant?: string };

export function registerRotate(program: Command): void {
  withTarget(
    program
      .command("rotate")
      .description("Re-key an environment: new encryption key, same values (needs the rotate permission)"),
  ).action(async (opts: Opts) => {
    const t = await resolveTarget(opts);
    const r = await hubRotate(asTarget(t));
    success(`Re-keyed ${c.bold(`${t.project}/${t.env}`)} for ${plural(r.kept.length, "person", "people")}`);
    if (r.versionsDropped) {
      warn(
        `${plural(r.versionsDropped, "older saved version")} couldn't be carried over (unreadable, or too much history for one request) and ${r.versionsDropped === 1 ? "was" : "were"} dropped. The newest ${r.versionsKept} ${r.versionsKept === 1 ? "was" : "were"} kept.`,
      );
    }
    hint("Rotating changes the key, not the secrets. If someone who knew the values left, change the values too.");
  });
}
