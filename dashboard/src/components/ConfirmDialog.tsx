import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ConfirmOptions = {
  title: string;
  /** Plain text; line breaks are kept. */
  description?: string;
  /** Monospace block under the description, e.g. a key fingerprint. */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button and a warning icon, for actions that can't be undone. */
  destructive?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

/** Promise-based replacement for `window.confirm`: `if (!(await confirm({...}))) return;`. */
export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const settle = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(ok);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // A second request while one is open cancels the first rather than stacking.
      pendingRef.current?.resolve(false);
      const next = { ...options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={pending !== null} onOpenChange={(open) => !open && settle(false)}>
        <DialogContent>
          {pending && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {pending.destructive && (
                    <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
                  )}
                  {pending.title}
                </DialogTitle>
                {pending.description && (
                  <DialogDescription className="whitespace-pre-line">
                    {pending.description}
                  </DialogDescription>
                )}
              </DialogHeader>
              {pending.detail && (
                <pre className="rounded-md border bg-muted/50 p-3 font-mono text-xs break-all whitespace-pre-wrap">
                  {pending.detail}
                </pre>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => settle(false)}>
                  {pending.cancelLabel ?? "Cancel"}
                </Button>
                <Button
                  type="button"
                  variant={pending.destructive ? "destructive" : "default"}
                  onClick={() => settle(true)}
                >
                  {pending.confirmLabel ?? "Continue"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
