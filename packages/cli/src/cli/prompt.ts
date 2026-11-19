import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/** Interactive password prompt — echoes `*` per character (TTY only). */
export async function promptPassword(question: string): Promise<string> {
  output.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;

    const cleanup = () => {
      input.off("data", onData);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\n" || char === "\r") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (char < " ") continue;
        value += char;
        output.write("*");
      }
    };

    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

/** Ask a one-line question on the terminal. Throws when there is no terminal to ask on. */
export async function promptLine(question: string): Promise<string> {
  if (!input.isTTY) throw new Error("This needs a terminal to ask you. Re-run with --yes to skip the question.");
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Yes/no question, default no. `--yes` skips it; with no terminal and no `--yes` it refuses. */
export async function confirmAction(question: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  const answer = await promptLine(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}

/** For irreversible actions: the user must type `expected` back (or pass `--yes`). */
export async function confirmTyped(question: string, expected: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  const answer = await promptLine(`${question}\nType "${expected}" to confirm: `);
  return answer === expected;
}
