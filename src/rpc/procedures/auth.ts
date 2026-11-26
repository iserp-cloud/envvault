import { logError } from "../../log.js";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { AUTH_KEY_RE } from "../../auth-proof.js";
import { recordAudit } from "../../audit.js";
import { getUser, latestSessionExpiry } from "../../db/store.js";
import {
  AccountDisabledError,
  changePassword,
  isVaultInitialized,
  loginUser,
  preloginParams,
  recoverAccount,
  recoveryBundle,
  registerUser,
  setRecovery,
} from "../runtime.js";
import {
  AuthedContext,
  KdfSchema,
  SealedBoxSchema,
  authed,
  base,
  dbOf,
  requireHuman,
  reqMeta,
  requireUsername,
  sessionFields,
} from "../base.js";
import { signupMode } from "../../security.js";
import { assertNotThrottled, clearFailures, clientIp, rateLimit, recordFailure } from "../../ratelimit.js";
import {
  hasLoginFromAddress,
  listSessionsForUser,
  revokeOtherSessions,
  revokeSessionById,
} from "../../db/store.js";

/**
 * Per-account failure throttle that can't be used to lock the real owner out: once an
 * account is throttled, attempts from an address that has signed in to it before still
 * get through (they must still pass the password and the per-address limits).
 */
async function assertAccountAttemptAllowed(
  context: Parameters<typeof clientIp>[0] & { db: Parameters<typeof assertNotThrottled>[0] },
  username: string,
  /** Login and recovery keep separate counters, so failing one can't block the other. */
  scope: "acct" | "racct" = "acct",
): Promise<void> {
  try {
    await assertNotThrottled(context.db, `${scope}:${username}`, 12);
  } catch (err) {
    if (await hasLoginFromAddress(context.db, username, clientIp(context))) return;
    throw err;
  }
}

const AuthKeySchema = z.string().regex(AUTH_KEY_RE, "Invalid auth key");
const PublicKeySchema = z.string().min(100).max(2000);
const UsernameSchema = z.string().trim().min(1).max(64);

const RecoverySchema = z.object({
  authKey: AuthKeySchema,
  wrappedPrivateKey: SealedBoxSchema,
});

export const health = base.handler(async () => ({ ok: true as const }));

export const status = base.handler(async ({ context }) => {
  const initialized = await isVaultInitialized(dbOf(context));
  return {
    initialized,
    // The first account can always be created (it becomes the admin).
    signupMode: initialized ? signupMode() : ("open" as const),
    // The first account always needs a setup token (the server fails closed without one).
    requiresSetupToken: !initialized,
  };
});

/** Tells the client which KDF parameters to use before it can derive its login proof. */
export const prelogin = base
  .input(z.object({ username: UsernameSchema }))
  .handler(async ({ input, context }) => {
    await rateLimit(dbOf(context), `prelogin:${clientIp(context)}`, { limit: 60, windowMs: 15 * 60_000 });
    return preloginParams(dbOf(context), input.username);
  });

export const signup = base
  .input(
    z.object({
      username: UsernameSchema,
      authKey: AuthKeySchema,
      kdf: KdfSchema,
      publicKey: PublicKeySchema,
      wrappedPrivateKey: SealedBoxSchema,
      recovery: RecoverySchema,
      /** Admin-issued invite, or the setup token for the very first account. */
      inviteToken: z.string().min(8).max(200).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    await rateLimit(dbOf(context), `signup:${clientIp(context)}`, { limit: 10, windowMs: 15 * 60_000 });

    try {
      const result = await registerUser(dbOf(context), input, reqMeta(context));
      await recordAudit(context, { actor: result.username, action: "account.signup" });
      return sessionFields(result);
    } catch (err) {
      if (err instanceof ORPCError) throw err;
      const message = err instanceof Error ? err.message : "Sign up failed";
      if (/disabled/i.test(message)) {
        throw new ORPCError("FORBIDDEN", { message: "Sign up is disabled" });
      }
      if (/invite|setup token/i.test(message)) {
        throw new ORPCError("FORBIDDEN", { message });
      }
      if (/already taken|already set up|unique|duplicate/i.test(message)) {
        // Don't confirm which usernames exist.
        throw new ORPCError("BAD_REQUEST", {
          message: "Unable to create account with that username",
        });
      }
      if (/Username must|reserved|required|Unsupported key/i.test(message)) {
        throw new ORPCError("BAD_REQUEST", { message });
      }
      logError("signup", err);
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Sign up failed" });
    }
  });

export const login = base
  .input(
    z.object({
      username: UsernameSchema,
      authKey: AuthKeySchema,
    }),
  )
  .handler(async ({ input, context }) => {
    const ip = clientIp(context);
    const userKey = input.username.trim().toLowerCase();
    const db = dbOf(context);
    await rateLimit(db, `login:${ip}:${userKey}`, { limit: 8, windowMs: 15 * 60_000 });
    await rateLimit(db, `login:${ip}`, { limit: 30, windowMs: 15 * 60_000 });
    // Failures per account across every address, so spreading a guess over many IPs doesn't help.
    await assertAccountAttemptAllowed(context, userKey);

    if (!(await isVaultInitialized(db))) {
      throw new ORPCError("BAD_REQUEST", {
        message: "No accounts yet. Create the first account to get started.",
      });
    }
    try {
      const result = await loginUser(db, input, reqMeta(context));
      await clearFailures(db, `acct:${userKey}`);
      // Only guesses count against the per-address limit: unlocking the dashboard is a sign-in too,
      // and a correct password must not use up the attempts a wrong one would.
      await clearFailures(db, `login:${ip}:${userKey}`);
      await recordAudit(context, { actor: result.username, action: "account.login" });
      return sessionFields(result);
    } catch (err) {
      if (err instanceof AccountDisabledError) {
        throw new ORPCError("FORBIDDEN", { message: err.message });
      }
      if (err instanceof Error && /invalid username or password/i.test(err.message)) {
        await recordFailure(db, `acct:${userKey}`, 15 * 60_000);
        await recordAudit(context, { actor: "", action: "account.login_failed", target: userKey });
        throw new ORPCError("FORBIDDEN", { message: "Invalid username or password" });
      }
      logError("login", err);
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Login failed" });
    }
  });

export const changePasswordProc = authed
  .input(
    z.object({
      currentAuthKey: AuthKeySchema,
      newAuthKey: AuthKeySchema,
      newKdf: KdfSchema,
      newWrappedPrivateKey: SealedBoxSchema,
    }),
  )
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    await rateLimit(dbOf(context), `chpw:${username}`, { limit: 8, windowMs: 15 * 60_000 });
    try {
      const result = await changePassword(dbOf(context), { username, ...input }, reqMeta(context));
      await recordAudit(context, { actor: username, action: "account.password_changed" });
      return { ok: true as const, sessionToken: result.sessionToken };
    } catch (err) {
      if (err instanceof ORPCError) throw err;
      logError("changePassword", err);
      throw new ORPCError("FORBIDDEN", { message: "Unable to change password" });
    }
  });

/** Replace the recovery key: needs a session and the current password (like changing the password). */
export const setRecoveryProc = authed
  .input(RecoverySchema.extend({ currentAuthKey: AuthKeySchema }))
  .handler(async ({ input, context }) => {
    const username = requireHuman((context as AuthedContext).auth);
    await rateLimit(dbOf(context), `rcvset:${username}`, { limit: 8, windowMs: 15 * 60_000 });
    try {
      await setRecovery(dbOf(context), username, {
        currentAuthKey: input.currentAuthKey,
        authKey: input.authKey,
        wrappedPrivateKey: input.wrappedPrivateKey,
      });
    } catch (err) {
      if (err instanceof Error && /invalid current password/i.test(err.message)) {
        await recordAudit(context, { actor: username, action: "account.recovery_key_replace_denied" });
        throw new ORPCError("FORBIDDEN", { message: "Invalid current password" });
      }
      logError("setRecovery", err);
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not replace the recovery key" });
    }
    await recordAudit(context, { actor: username, action: "account.recovery_key_replaced" });
    return { ok: true as const };
  });

async function recoveryError(
  db: ReturnType<typeof dbOf>,
  username: string,
  err: unknown,
): Promise<never> {
  if (err instanceof AccountDisabledError) {
    throw new ORPCError("FORBIDDEN", { message: err.message });
  }
  if (err instanceof Error && /invalid username or recovery key/i.test(err.message)) {
    // Count it against the account, like a failed login, so guesses can't be spread across addresses.
    await recordFailure(db, `racct:${username.trim().toLowerCase()}`, 15 * 60_000);
    throw new ORPCError("FORBIDDEN", { message: "Invalid username or recovery key" });
  }
  if (err instanceof ORPCError) throw err;
  if (err instanceof Error && /Unsupported key/.test(err.message)) {
    throw new ORPCError("BAD_REQUEST", { message: err.message });
  }
  logError("recovery", err);
  throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Recovery failed" });
}

/** Recovery step 1: prove the recovery key, receive the recovery-sealed private key. */
export const recoveryBundleProc = base
  .input(z.object({ username: UsernameSchema, recoveryAuthKey: AuthKeySchema }))
  .handler(async ({ input, context }) => {
    const ip = clientIp(context);
    await rateLimit(dbOf(context), `recover:${ip}:${input.username.toLowerCase()}`, { limit: 6, windowMs: 15 * 60_000 });
    await rateLimit(dbOf(context), `recover:${ip}`, { limit: 20, windowMs: 15 * 60_000 });
    await assertAccountAttemptAllowed(context, input.username.trim().toLowerCase(), "racct");
    try {
      return await recoveryBundle(dbOf(context), input);
    } catch (err) {
      return recoveryError(dbOf(context), input.username, err);
    }
  });

/** Recovery step 2: set a new password. */
export const recoverProc = base
  .input(
    z.object({
      username: UsernameSchema,
      recoveryAuthKey: AuthKeySchema,
      newAuthKey: AuthKeySchema,
      newKdf: KdfSchema,
      newWrappedPrivateKey: SealedBoxSchema,
    }),
  )
  .handler(async ({ input, context }) => {
    const ip = clientIp(context);
    await rateLimit(dbOf(context), `recover:${ip}:${input.username.toLowerCase()}`, { limit: 6, windowMs: 15 * 60_000 });
    await rateLimit(dbOf(context), `recover:${ip}`, { limit: 20, windowMs: 15 * 60_000 });
    await assertAccountAttemptAllowed(context, input.username.trim().toLowerCase(), "racct");
    try {
      const result = await recoverAccount(dbOf(context), input, reqMeta(context));
      await recordAudit(context, { actor: result.username, action: "account.recovered" });
      await clearFailures(dbOf(context), `racct:${input.username.trim().toLowerCase()}`);
      return sessionFields(result);
    } catch (err) {
      return recoveryError(dbOf(context), input.username, err);
    }
  });

export const me = authed.handler(async ({ context }) => {
  const { username, role, kind } = (context as AuthedContext).auth;
  // A service token can learn when it stops working, so whatever runs it can warn ahead of time.
  const expiresAt = kind === "service" ? await latestSessionExpiry(dbOf(context), username) : undefined;
  return { username, role, kind, ...(expiresAt ? { expiresAt } : {}) };
});

// ── sessions (signed-in devices) ───────────────────────────────────────────

export const sessionsList = authed.handler(async ({ context }) => {
  const { username, sessionHash } = (context as AuthedContext).auth;
  const rows = await listSessionsForUser(dbOf(context), username);
  return rows.map((r) => ({
    id: r.token.slice(0, 16),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ip: r.ip,
    userAgent: r.user_agent,
    current: r.token === sessionHash,
  }));
});

export const sessionsRevoke = authed
  .input(z.object({ id: z.string().regex(/^[a-f0-9]{16}$/) }))
  .handler(async ({ input, context }) => {
    const { username } = (context as AuthedContext).auth;
    if (!(await revokeSessionById(dbOf(context), username, input.id))) {
      throw new ORPCError("NOT_FOUND", { message: "Session not found" });
    }
    await recordAudit(context, { actor: username, action: "account.session_revoked" });
    return { ok: true as const };
  });

export const sessionsRevokeOthers = authed.handler(async ({ context }) => {
  const { username, sessionHash } = (context as AuthedContext).auth;
  await revokeOtherSessions(dbOf(context), username, sessionHash ?? "");
  await recordAudit(context, { actor: username, action: "account.sessions_revoked_others" });
  return { ok: true as const };
});

export const usersResolve = authed
  .input(z.object({ username: z.string().trim().min(1) }))
  .handler(async ({ input, context }) => {
    requireUsername((context as AuthedContext).auth);
    const user = await getUser(dbOf(context), input.username.trim().toLowerCase());
    if (!user || user.status !== "active") {
      throw new ORPCError("NOT_FOUND", { message: "User not found" });
    }
    return { username: user.username, publicKey: user.public_key };
  });
