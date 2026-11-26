import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Props = {
  environments: { name: string }[];
  value: string | null;
  onChange: (name: string) => void;
  /** Offered when set: a "New environment" entry, prefilled with what was typed. */
  onCreate?: (suggestedName: string) => void;
  disabled?: boolean;
};

/** Pick the environment of the open project: one choice, with search as you type. */
export function EnvironmentCombobox({ environments, value, onChange, onCreate, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  function close() {
    setOpen(false);
    setQuery("");
  }

  const typed = query.trim();
  const exists = environments.some((e) => e.name.toLowerCase() === typed.toLowerCase());

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Environment"
          disabled={disabled}
          className="h-8 w-56 justify-between px-3 font-normal"
        >
          <span className={cn("truncate font-medium", !value && "text-muted-foreground")}>{value ?? "Choose an environment"}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search environments…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No environment matches.</CommandEmpty>
            <CommandGroup>
              {environments.map((e) => (
                <CommandItem
                  key={e.name}
                  value={e.name}
                  onSelect={() => {
                    onChange(e.name);
                    close();
                  }}
                >
                  <Check className={cn("size-4", value === e.name ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{e.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {onCreate && (
            <div className="border-t p-1">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
                onClick={() => {
                  close();
                  onCreate(typed && !exists ? typed : "");
                }}
              >
                <Plus className="size-4" />
                <span className="truncate">{typed && !exists ? `Create “${typed}”` : "New environment"}</span>
              </button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
