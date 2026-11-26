import { useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { DEFAULT_GROUP, cleanLabels, validateGroupName } from "@envvault/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The group names of one environment. Registering a name here makes it a choice on every key's Group menu,
 * so nobody types (and mistypes) it again. The list is saved inside the encrypted environment, never as
 * plain text on the hub.
 */
export function GroupRegistry({
  labels,
  inUse,
  canWrite,
  onChange,
}: {
  /** The registered names. */
  labels: string[];
  /** How many keys are in each group, for every group that has a key. */
  inUse: Record<string, number>;
  canWrite: boolean;
  onChange: (labels: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const shown = cleanLabels([...labels, ...Object.keys(inUse)]);

  function add(e: FormEvent) {
    e.preventDefault();
    const name = draft.trim().toLowerCase();
    if (!name) return;
    const bad = name === DEFAULT_GROUP ? `"${DEFAULT_GROUP}" is the group every other key is in` : validateGroupName(name);
    if (bad) return setProblem(bad);
    setProblem(null);
    setDraft("");
    onChange(cleanLabels([...labels, name]));
  }

  return (
    <div className="mb-4 rounded-xl border bg-card p-4 shadow-xs">
      <p className="text-sm font-medium">Key groups</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        A Kubernetes link takes one group and writes it as a Secret or a ConfigMap. Keys with no group are in
        "{DEFAULT_GROUP}". Names are lowercase letters, digits and dashes.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {shown.length === 0 && <span className="text-sm text-muted-foreground">No groups yet.</span>}
        {shown.map((name) => {
          const used = inUse[name] ?? 0;
          return (
            <Badge key={name} variant="outline" className="gap-1.5 py-1 font-mono text-xs">
              {name}
              <span className="text-muted-foreground">{used === 0 ? "unused" : `${used} ${used === 1 ? "key" : "keys"}`}</span>
              {canWrite && (
                <button
                  type="button"
                  className="rounded-sm text-muted-foreground hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={used > 0}
                  title={used > 0 ? "Move its keys to another group first" : `Remove ${name}`}
                  aria-label={`Remove group ${name}`}
                  onClick={() => onChange(labels.filter((l) => l !== name))}
                >
                  <X className="size-3" />
                </button>
              )}
            </Badge>
          );
        })}
      </div>
      {canWrite && (
        <form noValidate onSubmit={add} className="mt-3 flex items-start gap-2">
          <div className="space-y-1">
            <Input
              className="h-8 w-56 font-mono text-[13px]"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setProblem(null);
              }}
              placeholder="new group, e.g. db"
              aria-label="New group name"
              spellCheck={false}
            />
            {problem && <p className="text-xs text-destructive">{problem}</p>}
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={!draft.trim()}>
            Add group
          </Button>
        </form>
      )}
    </div>
  );
}
