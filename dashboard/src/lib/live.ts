import { useEffect, useRef } from "react";

/**
 * Run `tick` every `intervalMs` while the tab is visible, and right away when the user
 * comes back to it. Polling (rather than a socket) works the same on the Node hub and on
 * serverless Workers, where requests can't hold a connection open.
 * Overlapping ticks are skipped; errors are the caller's to handle.
 */
export function useLivePolling(tick: (() => Promise<void>) | null, intervalMs: number): void {
  const latest = useRef(tick);
  latest.current = tick;
  const inFlight = useRef(false);

  useEffect(() => {
    if (!tick) return;
    const run = async () => {
      if (inFlight.current || document.visibilityState !== "visible") return;
      inFlight.current = true;
      try {
        await latest.current?.();
      } finally {
        inFlight.current = false;
      }
    };
    const timer = setInterval(() => void run(), intervalMs);
    const onWake = () => void run();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
    // Only (re)subscribe when polling is switched on/off; `latest` carries the current closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick === null, intervalMs]);
}
