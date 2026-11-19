import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type MemberOption = {
  username: string;
  role?: string;
  status?: string;
};

type Props = {
  members: MemberOption[];
  value: string;
  onChange: (username: string) => void;
  placeholder?: string;
  disabled?: boolean;
  exclude?: string[];
  /** Only show active members by default */
  activeOnly?: boolean;
};

export function MemberCombobox({
  members,
  value,
  onChange,
  placeholder = "Search members…",
  disabled,
  exclude = [],
  activeOnly = true,
}: Props) {
  const [open, setOpen] = useState(false);

  const options = useMemo(() => {
    const excluded = new Set(exclude);
    return members.filter((m) => {
      if (excluded.has(m.username)) return false;
      if (activeOnly && m.status && m.status !== "active") return false;
      return true;
    });
  }, [members, exclude, activeOnly]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-9 w-full justify-between px-3 font-normal"
        >
          <span className={cn(!value && "text-muted-foreground")}>
            {value || placeholder}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Type a username…" />
          <CommandList>
            <CommandEmpty>No matching members.</CommandEmpty>
            <CommandGroup>
              {options.map((m) => (
                <CommandItem
                  key={m.username}
                  value={m.username}
                  onSelect={(current) => {
                    onChange(current === value ? "" : current);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "size-4",
                      value === m.username ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="font-medium">{m.username}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {[m.status === "pending" ? "pending" : null, m.role]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
