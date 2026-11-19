import { useState, type FormEvent } from "react";
import { unlockStoredSession, type Session, type StoredSession } from "@/api";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  stored: StoredSession;
  onUnlocked: (session: Session) => void;
  /** Forget this session and sign in as someone else. */
  onSwitchAccount: () => void;
};

/** Shown after a refresh or idle lock: the session is still valid, only the key is missing. */
export function LockScreen({ stored, onUnlocked, onSwitchAccount }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("Password is required");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      onUnlocked(await unlockStoredSession(stored, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't unlock");
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center p-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo />
          <span className="text-lg font-semibold tracking-tight">EnvVault</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Unlock your vault</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{stored.username}</span>. Enter
          your password to continue.
        </p>
        <form className="mt-6 space-y-4" noValidate onSubmit={(e) => void onSubmit(e)}>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="unlock-password">Password</Label>
            <Input
              id="unlock-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(error)}
              autoComplete="current-password"
              autoFocus
            />
          </div>
          <Button className="h-10 w-full" type="submit" disabled={busy}>
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={onSwitchAccount}
          >
            Not you? Sign in as someone else
          </button>
        </form>
      </div>
    </main>
  );
}
