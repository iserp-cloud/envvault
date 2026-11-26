import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  clearAllCredentials,
  forgetUnlock,
  loadStoredSession,
  restoreUnlocked,
  touchUnlock,
  saveSession,
  revokeRemoteSession,
  type Session,
  type StoredSession,
} from "@/api";
import { LockScreen } from "@/components/LockScreen";
import { UnlockScreen } from "@/UnlockScreen";
import { useIdleLock } from "@/lib/idle";

// Split the large vault UI out so the sign-in screen loads fast.
const VaultApp = lazy(() =>
  import("@/VaultApp").then((m) => ({ default: m.VaultApp })),
);

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  /** A valid hub session whose decrypted key isn't in memory (after a refresh or lock). */
  const [stored, setStored] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const kept = loadStoredSession();
    // A refresh shortly after the last activity keeps the vault unlocked; otherwise the password is asked for.
    void (kept ? restoreUnlocked(kept) : Promise.resolve(null)).then((unlocked) => {
      if (unlocked) setSession(unlocked);
      else setStored(kept);
      setReady(true);
    });
  }, []);

  function onUnlocked(next: Session) {
    saveSession(next);
    setStored(null);
    setSession(next);
  }

  // Drop the decrypted key from memory but keep the session: unlocking needs only the password.
  const lock = useCallback(() => {
    forgetUnlock();
    if (session) {
      const { privateKey: _privateKey, ...rest } = session;
      setStored(rest);
    }
    setSession(null);
  }, [session]);

  // End the session on the hub and forget it here.
  function onSignOut() {
    const current = session;
    setSession(null);
    setStored(null);
    clearAllCredentials();
    if (current) void revokeRemoteSession(current);
  }

  // The hub rejected our token (expired, revoked, disabled): back to a full sign-in.
  function onAuthFailure() {
    clearAllCredentials();
    setStored(null);
    setSession(null);
  }

  function onSessionUpdate(next: Session) {
    saveSession(next);
    setSession(next);
  }

  // Lock (and wipe in-memory keys) after 15 minutes without input.
  useIdleLock(session ? lock : null, 15);

  // Activity keeps the refresh grace window open.
  useEffect(() => {
    if (!session) return;
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"] as const;
    for (const e of events) window.addEventListener(e, touchUnlock, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, touchUnlock);
    };
  }, [session]);

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <p className="font-display text-lg font-semibold text-muted-foreground">
          EnvVault
        </p>
      </div>
    );
  }

  if (session) {
    return (
      <Suspense fallback={null}>
        <VaultApp
          session={session}
          onLock={lock}
          onSignOut={onSignOut}
          onSessionUpdate={onSessionUpdate}
          onAuthFailure={onAuthFailure}
        />
      </Suspense>
    );
  }
  if (stored) {
    return (
      <LockScreen
        stored={stored}
        onUnlocked={onUnlocked}
        onSwitchAccount={() => {
          void revokeRemoteSession(stored);
          onAuthFailure();
        }}
      />
    );
  }
  return <UnlockScreen onUnlocked={onUnlocked} />;
}
