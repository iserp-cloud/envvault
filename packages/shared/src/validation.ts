/** Input validation shared by the dashboard and CLI (the hub re-checks what it can). */

import { normalizeSlug } from "./naming.js";
import { parseRecoveryKey } from "./zk.js";

export const MIN_PASSWORD_LENGTH = 8;
/** Argon2id/PBKDF2 inputs are cheap to bound; this only stops absurd pastes. */
export const MAX_PASSWORD_LENGTH = 256;

/** Returns an error message, or null when the password is acceptable. */
export function validateNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters — a passphrase works best`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Use at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  if (password.trim().length === 0) return "Password can't be only spaces";
  return null;
}

/** Username / organization name rules (same namespace as the hub). */
export function validateHandle(raw: string, label = "Username"): string | null {
  if (!raw.trim()) return `${label} is required`;
  try {
    normalizeSlug(raw, label);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : `Invalid ${label.toLowerCase()}`;
  }
}

export function validateRecoveryKeyFormat(raw: string): string | null {
  if (!raw.trim()) return "Recovery key is required";
  try {
    parseRecoveryKey(raw);
    return null;
  } catch {
    return "That doesn't look like a recovery key (13 groups of 4 characters)";
  }
}

export function validateRequired(raw: string, label: string): string | null {
  return raw.trim() ? null : `${label} is required`;
}
