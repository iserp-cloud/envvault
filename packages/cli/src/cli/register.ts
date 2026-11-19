import type { Command } from "commander";
import { registerAccess } from "../commands/access.js";
import { registerAuth } from "../commands/auth.js";
import { registerData } from "../commands/data.js";
import { registerEnv } from "../commands/env.js";
import { registerHistory } from "../commands/history.js";
import { registerRemote } from "../commands/remote.js";
import { registerRotate } from "../commands/rotate.js";
import { registerTree } from "../commands/tree.js";
import { registerWorkspace } from "../commands/workspace.js";

/** Commands, in the order `--help` shows them: account, workspace, data, then management. */
export function registerCommands(program: Command): void {
  registerRemote(program);
  registerAuth(program);
  registerWorkspace(program);
  registerData(program);
  registerTree(program);
  registerEnv(program);
  registerHistory(program);
  registerAccess(program);
  registerRotate(program);
}
