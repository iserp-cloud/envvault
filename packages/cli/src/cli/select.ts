import { stdin as input, stdout as output } from "node:process";
import { c } from "../ui.js";

export type Choice<T> = { label: string; hint?: string; value: T };

/** What a key press means to the list. */
export type Key =
  | { name: "up" | "down" | "pageup" | "pagedown" | "space" | "all" | "backspace" | "enter" | "cancel" }
  | { name: "char"; char: string };

export type SelectState = {
  /** Text typed to narrow the list. */
  filter: string;
  /** Index into the *visible* (filtered) list. */
  cursor: number;
  chosen: Set<number>;
  done: "submit" | "cancel" | null;
};

export function initialState(): SelectState {
  return { filter: "", cursor: 0, chosen: new Set(), done: null };
}

/** Indexes (into `labels`) that match the filter, in order. */
export function visibleIndexes(labels: string[], filter: string): number[] {
  const q = filter.trim().toLowerCase();
  const all = labels.map((_, i) => i);
  return q ? all.filter((i) => labels[i]!.toLowerCase().includes(q)) : all;
}

/** Pure reducer, so the behaviour is testable without a terminal. */
export function step(state: SelectState, key: Key, labels: string[], pageSize: number): SelectState {
  const next: SelectState = { ...state, chosen: new Set(state.chosen) };
  const visible = visibleIndexes(labels, state.filter);
  const last = Math.max(0, visible.length - 1);
  const clamp = (n: number) => Math.min(last, Math.max(0, n));

  switch (key.name) {
    case "up":
      next.cursor = visible.length ? (state.cursor <= 0 ? last : state.cursor - 1) : 0;
      break;
    case "down":
      next.cursor = visible.length ? (state.cursor >= last ? 0 : state.cursor + 1) : 0;
      break;
    case "pageup":
      next.cursor = clamp(state.cursor - pageSize);
      break;
    case "pagedown":
      next.cursor = clamp(state.cursor + pageSize);
      break;
    case "space": {
      const index = visible[state.cursor];
      if (index !== undefined) {
        if (next.chosen.has(index)) next.chosen.delete(index);
        else next.chosen.add(index);
      }
      break;
    }
    case "all": {
      // Toggle everything shown: select all, or clear them when they already are.
      const every = visible.length > 0 && visible.every((i) => next.chosen.has(i));
      for (const i of visible) {
        if (every) next.chosen.delete(i);
        else next.chosen.add(i);
      }
      break;
    }
    case "char":
      next.filter = state.filter + key.char;
      next.cursor = 0;
      break;
    case "backspace":
      next.filter = state.filter.slice(0, -1);
      next.cursor = 0;
      break;
    case "enter":
      next.done = "submit";
      break;
    case "cancel":
      next.done = "cancel";
      break;
  }
  return next;
}

/** Decode one chunk of raw terminal input into keys. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!;
    if (ch === "\u001b") {
      const rest = chunk.slice(i);
      const seq = /^\u001b\[(A|B|5~|6~)/.exec(rest) ?? /^\u001bO(A|B)/.exec(rest);
      if (seq) {
        const code = seq[1]!;
        keys.push({ name: code === "A" ? "up" : code === "B" ? "down" : code === "5~" ? "pageup" : "pagedown" });
        i += seq[0].length - 1;
      } else if (rest.length === 1) {
        keys.push({ name: "cancel" });
      } else {
        i = chunk.length; // some other escape sequence: ignore it whole
      }
    } else if (ch === "\r" || ch === "\n") keys.push({ name: "enter" });
    else if (ch === "\u0003" || ch === "\u0004") keys.push({ name: "cancel" });
    else if (ch === "\u0001") keys.push({ name: "all" }); // ctrl+a
    else if (ch === "\u007f" || ch === "\b") keys.push({ name: "backspace" });
    else if (ch === " ") keys.push({ name: "space" });
    else if (ch >= " ") keys.push({ name: "char", char: ch });
  }
  return keys;
}

function render<T>(message: string, choices: Choice<T>[], state: SelectState, pageSize: number): string[] {
  const labels = choices.map((x) => x.label);
  const visible = visibleIndexes(labels, state.filter);
  const start = Math.max(0, Math.min(state.cursor - Math.floor(pageSize / 2), visible.length - pageSize));
  const lines = [
    `${c.bold(message)} ${c.dim(`(${state.chosen.size} selected)`)}`,
    c.dim("↑/↓ move · space select · ctrl+a all · type to filter · enter confirm · esc cancel"),
    `${c.dim("filter:")} ${state.filter}${c.dim("▏")}`,
  ];
  if (!visible.length) lines.push(c.dim("  no match"));
  for (let row = start; row < Math.min(visible.length, start + pageSize); row++) {
    const choice = choices[visible[row]!]!;
    const on = state.chosen.has(visible[row]!);
    const here = row === state.cursor;
    const box = on ? c.green("◉") : c.dim("◯");
    const label = here ? c.bold(choice.label) : choice.label;
    lines.push(`${here ? c.cyan("❯") : " "} ${box} ${label}${choice.hint ? `  ${c.dim(choice.hint)}` : ""}`);
  }
  if (visible.length > pageSize) lines.push(c.dim(`  … ${visible.length} shown, scroll for more`));
  return lines;
}

/**
 * Pick any number of items from a list. Resolves with the chosen values (in list order), or
 * `null` when cancelled. Needs a terminal; throws when there isn't one.
 */
export async function selectMany<T>(
  message: string,
  choices: Choice<T>[],
  opts: { pageSize?: number } = {},
): Promise<T[] | null> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive selection needs a terminal. Name the targets instead, e.g. `envvault tree pull web api`.");
  }
  const pageSize = opts.pageSize ?? 12;
  const labels = choices.map((x) => x.label);
  let state = initialState();
  let drawn = 0;

  const draw = () => {
    const lines = render(message, choices, state, pageSize);
    if (drawn) output.write(`\u001b[${drawn}A`); // back to the top of the last frame
    output.write(lines.map((l) => `\u001b[2K${l}`).join("\n") + "\u001b[0J\n");
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    const finish = (result: T[] | null) => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\u001b[?25h");
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      for (const key of parseKeys(chunk.toString("utf8"))) {
        state = step(state, key, labels, pageSize);
        if (state.done === "cancel") return finish(null);
        if (state.done === "submit") {
          draw();
          return finish(choices.filter((_, i) => state.chosen.has(i)).map((x) => x.value));
        }
      }
      draw();
    };
    output.write("\u001b[?25l");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    draw();
  });
}
