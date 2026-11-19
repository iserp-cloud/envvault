import { useEffect } from "react";

const EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"] as const;

/**
 * Call `onIdle` after `minutes` without user input. Decrypted keys live only in
 * memory, so locking (clearing the session) also wipes them.
 */
export function useIdleLock(onIdle: (() => void) | null, minutes: number): void {
  useEffect(() => {
    if (!onIdle) return;
    let timer = setTimeout(onIdle, minutes * 60_000);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, minutes * 60_000);
    };
    for (const e of EVENTS) window.addEventListener(e, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of EVENTS) window.removeEventListener(e, reset);
    };
  }, [onIdle, minutes]);
}
