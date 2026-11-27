import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * macOS keeps "secure input" (the lock in the menu bar) on while a password field has focus, and it can stay on
 * if that field is removed or changes type while still focused, because the browser never sees it lose focus.
 * So an input that disappears while focused is blurred first.
 */
function Input({ className, type, ref, ...props }: React.ComponentProps<"input">) {
  const own = React.useRef<HTMLInputElement | null>(null);
  React.useLayoutEffect(() => {
    return () => {
      const el = own.current;
      if (el && document.activeElement === el) el.blur();
    };
  }, []);
  // a type change (reveal / hide) happens in place: let go of focus first, then it is re-taken by the user
  React.useLayoutEffect(() => {
    const el = own.current;
    if (el && type !== "password" && el.dataset.wasPassword === "1" && document.activeElement === el) el.blur();
    if (el) el.dataset.wasPassword = type === "password" ? "1" : "0";
  }, [type]);
  return (
    <input
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
      }}
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
