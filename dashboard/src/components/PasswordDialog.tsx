import { useEffect, useState, type FormEvent } from "react";
import { changePassword, type Session } from "@/api";
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
import { validateNewPassword } from "@envvault/shared";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onChanged: (session: Session) => void;
  onAuthFailure: () => void;
};

export function PasswordDialog({
  open,
  onOpenChange,
  session,
  busy,
  setBusy,
  onChanged,
  onAuthFailure,
}: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Start every open with a clean form.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!currentPassword) {
      setError("Enter your current password");
      return;
    }
    const weak = validateNewPassword(newPassword);
    if (weak) {
      setError(weak);
      return;
    }
    if (newPassword === currentPassword) {
      setError("Choose a password different from the current one");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }
    setBusy(true);
    try {
      const next = await changePassword(session, {
        currentPassword,
        newPassword,
        confirm: confirmPassword,
      });
      onChanged(next);
      onOpenChange(false);
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthFailure();
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form noValidate onSubmit={(e) => void onSubmit(e)}>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Updates your login password and re-wraps your private key.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="mt-4 space-y-3">
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={busy}>
              {busy ? "Updating…" : "Update password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
