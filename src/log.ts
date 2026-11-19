import { describeError } from "@envvault/shared";

/** Log a failure as `[tag] Name [code]: message`, never the raw error object or its data. */
export function logError(tag: string, err: unknown): void {
  console.error(`[${tag}] ${describeError(err)}`);
}
