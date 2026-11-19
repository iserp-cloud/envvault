import { useEffect, useState, type FormEvent } from "react";
import { regenerateRecoveryKey, type Session } from "@/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isUnauthorized } from "@/lib/auth-errors";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  /** Called with the new key, to be shown once. */
  onCreated: (recoveryKey: string) => void;
  onAuthFailure: () => void;
};

/** Replacing the recovery key needs your password, so a stolen session can't swap it. */
export function RecoveryKeyDialog({ open, onOpenChange, session, onCreated, onAuthFailure }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setError(null);
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!password) {
      setError("Enter your password");
      return;
    }
    setBusy(true);
    try {
      const key = await regenerateRecoveryKey(session, password);
      onOpenChange(false);
      onCreated(key);
    } catch (err) {
      // A wrong password is also reported as a failed call; only a dead session means "sign in again".
      if (isUnauthorized(err) && !/current password/i.test(String(err))) {
        onAuthFailure();
        return;
      }
      setError(err instanceof Error ? err.message : "Could not create a new recovery key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form noValidate onSubmit={(e) => void onSubmit(e)}>
          <DialogHeader>
            <DialogTitle>Generate a new recovery key?</DialogTitle>
            <DialogDescription>
              Your current recovery key will stop working. Enter your password to confirm.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="mt-4 space-y-2">
            <Label htmlFor="recovery-password">Password</Label>
            <Input
              id="recovery-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? "Generating…" : "Generate key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
