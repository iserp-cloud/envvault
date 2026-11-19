import { KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm ring-1 ring-inset ring-white/15",
        className,
      )}
    >
      <KeyRound className="size-[55%]" strokeWidth={2.25} />
    </span>
  );
}
