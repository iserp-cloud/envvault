import { Layers, ShieldCheck, Terminal } from "lucide-react";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { fetchStatus, loginVault, recoverVault, signupVault, type Session, type SignupMode } from "@/api";
import { RecoveryKeyPanel } from "@/components/RecoveryKeyPanel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  validateHandle,
  validateNewPassword,
  validateRecoveryKeyFormat,
  validateRequired,
} from "@envvault/shared";

type FieldErrors = Partial<
  Record<"username" | "recoveryKey" | "password" | "confirm" | "inviteToken", string>
>;

type Props = {
  onUnlocked: (session: Session) => void;
};

type AuthMode = "loading" | "login" | "signup" | "recover";

/** Invite token from `#invite=<token>` (kept in the fragment so it never reaches a server log). */
function readInviteFromHash(): string {
  try {
    const m = /(?:^|[#&])invite=([^&]+)/.exec(window.location.hash);
    return m ? decodeURIComponent(m[1]!) : "";
  } catch {
    return "";
  }
}

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

export function UnlockScreen({ onUnlocked }: Props) {
  const [mode, setMode] = useState<AuthMode>("loading");
  const [signupMode, setSignupMode] = useState<SignupMode>("invite");
  const [needsSetupToken, setNeedsSetupToken] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteToken, setInviteToken] = useState(readInviteFromHash);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState<{ session: Session; recoveryKey: string } | null>(null);

  const invited = Boolean(inviteToken) && !firstRun;
  const needsInvite =
    (firstRun && needsSetupToken) || (!firstRun && signupMode !== "open" && !invited);
  const signupAllowed = firstRun || invited || signupMode === "open";

  const probeServer = useCallback(async () => {
    try {
      const status = await fetchStatus();
      setSignupMode(status.signupMode);
      setNeedsSetupToken(status.requiresSetupToken);
      setFirstRun(!status.initialized);
      setMode((prev) => {
        if (prev === "signup" || prev === "login" || prev === "recover") return prev;
        return !status.initialized || readInviteFromHash() ? "signup" : "login";
      });
      return true;
    } catch {
      setMode((prev) => (prev === "loading" ? "login" : prev));
      return false;
    }
  }, []);

  useEffect(() => {
    setFieldErrors({});
  }, [mode]);

  useEffect(() => {
    void probeServer();
  }, [probeServer]);

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    const setting = mode === "signup" || mode === "recover";
    // Only new usernames must fit the naming rules; existing accounts just need a value.
    const u = mode === "signup" ? validateHandle(username) : validateRequired(username, "Username");
    if (u) errs.username = u;
    if (mode === "recover") {
      const r = validateRecoveryKeyFormat(recoveryKey);
      if (r) errs.recoveryKey = r;
    }
    if (setting) {
      const p = validateNewPassword(password);
      if (p) errs.password = p;
      else if (password !== confirm) errs.confirm = "Passwords do not match";
    } else if (!password) {
      errs.password = "Password is required";
    }
    if (mode === "signup" && needsInvite) {
      const t = validateRequired(inviteToken, firstRun ? "Setup token" : "Invite code");
      if (t) errs.inviteToken = t;
    }
    return errs;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setLoading(true);

    try {
      if (mode === "signup" || mode === "recover") {
        setWorking(mode === "signup" ? "Generating your encryption keys…" : "Recovering your account…");
      } else {
        setWorking("Deriving keys…");
      }
      if (mode === "signup") {
        const created = await signupVault(username, password, inviteToken);
        if (invited) history.replaceState(null, "", window.location.pathname);
        // Don't enter the app until the user has seen their recovery key.
        setPending(created);
      } else if (mode === "recover") {
        onUnlocked(await recoverVault(username, recoveryKey, password));
      } else {
        onUnlocked(await loginVault(username, password));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
      setWorking(null);
    }
  }

  const isSignup = mode === "signup";
  const isRecover = mode === "recover";
  const settingPassword = isSignup || isRecover;

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-[oklch(0.2_0.06_277)] p-12 text-white lg:flex lg:flex-col">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(60% 50% at 20% 0%, oklch(0.55 0.22 277 / 0.55), transparent), radial-gradient(50% 40% at 100% 100%, oklch(0.5 0.2 310 / 0.4), transparent)",
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <Logo className="size-9 bg-white/15 ring-white/25" />
          <span className="text-lg font-semibold tracking-tight">EnvVault</span>
        </div>
        <div className="relative mt-auto max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Your team&apos;s secrets, encrypted and in sync.
          </h2>
          <ul className="mt-8 space-y-4 text-[15px] text-white/75">
            {[
              [ShieldCheck, "End-to-end encrypted — only you hold the keys, never the server"],
              [Layers, "Organize by vault, project, and environment"],
              [Terminal, "Push and pull .env files from the CLI or CI"],
            ].map(([Icon, text], i) => {
              const I = Icon as typeof ShieldCheck;
              return (
                <li key={i} className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-white/10">
                    <I className="size-4" />
                  </span>
                  {text as string}
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      <main className="relative flex items-center justify-center p-6">
        <div className="absolute right-4 top-4">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <Logo />
            <span className="text-lg font-semibold tracking-tight">EnvVault</span>
          </div>
          {pending ? (
            <RecoveryKeyPanel
              recoveryKey={pending.recoveryKey}
              username={pending.session.username}
              onDone={() => onUnlocked(pending.session)}
            />
          ) : (
          <>
          <h1 className="text-2xl font-semibold tracking-tight">
            {mode === "recover"
              ? "Recover your account"
              : isSignup
                ? firstRun
                  ? "Set up EnvVault"
                  : "Create your account"
                : "Welcome back"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {mode === "loading"
              ? "Loading…"
              : isSignup
                ? firstRun
                  ? "This first account becomes the administrator."
                  : invited
                    ? "You've been invited. Choose a username and password."
                    : "Your personal vault is created automatically."
                : mode === "recover"
                  ? "Enter your recovery key and choose a new password."
                  : "Sign in to your vault."}
          </p>

        {mode !== "loading" && window.isSecureContext === false && (
          <Alert variant="destructive" className="mt-6">
            <AlertDescription>
              This page isn&apos;t using https, so your browser blocks the encryption EnvVault needs and
              you can&apos;t sign in from here. Open the hub over https, or from http://localhost (for
              example with <code className="font-mono">kubectl port-forward</code>).
            </AlertDescription>
          </Alert>
        )}

        {mode !== "loading" && (
          <div className="mt-8">
            <form className="space-y-4" noValidate onSubmit={(e) => void onSubmit(e)}>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  aria-invalid={Boolean(fieldErrors.username)}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="jane"
                  autoComplete="username"
                  autoFocus
                  spellCheck={false}
                />
                <FieldError message={fieldErrors.username} />
              </div>

              {isRecover && (
                <div className="space-y-2">
                  <Label htmlFor="recovery-key">Recovery key</Label>
                  <Input
                    id="recovery-key"
                    aria-invalid={Boolean(fieldErrors.recoveryKey)}
                    value={recoveryKey}
                    onChange={(e) => setRecoveryKey(e.target.value)}
                    placeholder="ABCD-EFGH-…"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                    />
                  <FieldError message={fieldErrors.recoveryKey} />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="password">{isRecover ? "New password" : "Password"}</Label>
                <Input
                  id="password"
                  aria-invalid={Boolean(fieldErrors.password)}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={settingPassword ? "at least 8 characters" : "your password"}
                  autoComplete={settingPassword ? "new-password" : "current-password"}
                />
                <FieldError message={fieldErrors.password} />
                {mode === "login" && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    onClick={() => {
                      setError(null);
                      setMode("recover");
                    }}
                  >
                    Forgot password?
                  </button>
                )}
              </div>

              {isSignup && firstRun && needsSetupToken && (
                <div className="space-y-2">
                  <Label htmlFor="setup-token">Setup token</Label>
                  <Input
                    id="setup-token"
                    aria-invalid={Boolean(fieldErrors.inviteToken)}
                    type="password"
                    value={inviteToken}
                    onChange={(e) => setInviteToken(e.target.value)}
                    placeholder="ENVVAULT_SETUP_TOKEN from the server"
                    autoComplete="off"
                    />
                  <FieldError message={fieldErrors.inviteToken} />
                </div>
              )}

              {isSignup && !firstRun && signupMode !== "open" && !invited && (
                <div className="space-y-2">
                  <Label htmlFor="invite">Invite code</Label>
                  <Input
                    id="invite"
                    aria-invalid={Boolean(fieldErrors.inviteToken)}
                    value={inviteToken}
                    onChange={(e) => setInviteToken(e.target.value)}
                    placeholder="Paste your invite code"
                    autoComplete="off"
                    spellCheck={false}
                    />
                  <FieldError message={fieldErrors.inviteToken} />
                </div>
              )}

              {settingPassword && (
                <div className="space-y-2">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input
                    id="confirm"
                    aria-invalid={Boolean(fieldErrors.confirm)}
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="type it again"
                    autoComplete="new-password"
                    />
                  <FieldError message={fieldErrors.confirm} />
                </div>
              )}

              <Button className="h-10 w-full" type="submit" disabled={loading}>
                {loading
                  ? (working ?? (isSignup ? "Signing up…" : "Signing in…"))
                  : isRecover
                    ? "Reset password"
                    : isSignup
                      ? firstRun
                        ? "Create administrator account"
                        : "Create account"
                      : "Sign in"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Your password never leaves this device — only a derived proof is sent.
              </p>

              {isRecover && (
                <Button
                  className="w-full"
                  variant="ghost"
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setError(null);
                    setMode("login");
                  }}
                >
                  Back to sign in
                </Button>
              )}

              {!firstRun && !isRecover && (signupAllowed || isSignup) && (
                <Button
                  className="w-full"
                  variant="ghost"
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setError(null);
                    setConfirm("");
                    setMode((m) => (m === "signup" ? "login" : "signup"));
                  }}
                >
                  {isSignup
                    ? "Already have an account? Sign in"
                    : signupMode === "open"
                      ? "Need an account? Sign up"
                      : "Have an invite code? Sign up"}
                </Button>
              )}
            </form>
          </div>
        )}
          </>
          )}
        </div>
      </main>
    </div>
  );
}
