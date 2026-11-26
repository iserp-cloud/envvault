import { ChevronDown, ChevronRight, Eye, EyeOff, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteEnvVersion,
  listEnvHistory,
  readEnvVersion,
  type EnvHistory as EnvHistoryData,
  type Session,
} from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isUnauthorized } from "@/lib/auth-errors";
import { diffEnv, type EnvChange } from "@/lib/env-diff";
import { formatDate } from "@/lib/env-rows";
import { useConfirm } from "@/components/ConfirmDialog";

type Props = {
  session: Session;
  projectName: string;
  environmentName: string;
  envDek: string;
  /** The saved content, which restoring would replace (unsaved edits are not included). */
  savedEnv: Record<string, string>;
  /** Bumped by the parent after a save so the list reloads. */
  reloadKey: string | null;
  canWrite: boolean;
  /** May delete saved versions (the delete permission). */
  canDelete: boolean;
  onRestore: (env: Record<string, string>, grouping: { groups: Record<string, string>; labels: string[] }, version: number) => void;
  onStatus: (message: string) => void;
  onError: (message: string | null) => void;
  onAuthFailure: () => void;
};

const KIND_LABEL: Record<EnvChange["kind"], string> = {
  added: "adds",
  removed: "removes",
  changed: "changes",
};

export function EnvHistory({
  session,
  projectName,
  environmentName,
  envDek,
  savedEnv,
  reloadKey,
  canWrite,
  canDelete,
  onRestore,
  onStatus,
  onError,
  onAuthFailure,
}: Props) {
  const confirm = useConfirm();
  const [data, setData] = useState<EnvHistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, Record<string, string>>>({});
  const [showValues, setShowValues] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      if (isUnauthorized(err)) return onAuthFailure();
      onError(err instanceof Error ? err.message : fallback);
    },
    [onAuthFailure, onError],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await listEnvHistory(session, projectName, environmentName));
    } catch (err) {
      fail(err, "Couldn't load history");
    } finally {
      setLoading(false);
    }
    // `session` identity changes on tenant switch only; the parent remounts us per environment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName, environmentName, session.token, session.activeTenantId, fail]);

  useEffect(() => {
    setOpen(null);
    setContents({});
    void load();
  }, [load, reloadKey]);

  async function toggle(id: string) {
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    if (contents[id]) return;
    try {
      const { env } = await readEnvVersion(session, projectName, environmentName, id, envDek);
      setContents((c) => ({ ...c, [id]: env }));
    } catch (err) {
      setOpen(null);
      fail(err, "Couldn't open that version");
    }
  }

  async function remove(id: string, version: number) {
    const ok = await confirm({
      title: `Delete version ${version}?`,
      description: "It can't be recovered.",
      confirmLabel: "Delete version",
      destructive: true,
    });
    if (!ok) return;
    setWorking(id);
    onError(null);
    try {
      await deleteEnvVersion(session, projectName, environmentName, id);
      onStatus(`Deleted version ${version}`);
      await load();
    } catch (err) {
      fail(err, "Delete failed");
    } finally {
      setWorking(null);
    }
  }

  const history = data?.history ?? [];
  const current = data?.current;
  const changes = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(contents).map(([id, env]) => [id, diffEnv(savedEnv, env)]),
      ) as Record<string, EnvChange[]>,
    [contents, savedEnv],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Version history</CardTitle>
          <CardDescription>
            Every save keeps the previous version (newest 50). Restoring loads an old version into
            the editor as a draft — you review it and save, which adds a new version.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowValues((v) => !v)}>
          {showValues ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          {showValues ? "Hide values" : "Show values"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {current && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">v{current.version}</span>
            <Badge variant="success">current</Badge>
            <span className="text-muted-foreground">
              {current.updatedBy ? `${current.updatedBy} · ` : ""}
              {formatDate(current.updatedAt)}
            </span>
            {current.note && <span className="text-muted-foreground">· {current.note}</span>}
          </div>
        )}

        {loading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && history.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No earlier versions yet — they appear here after the next save.
          </p>
        )}

        {history.map((v) => {
          const isOpen = open === v.id;
          const diff = changes[v.id];
          return (
            <div key={v.id} className="rounded-lg border">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => void toggle(v.id)}
                  aria-expanded={isOpen}
                >
                  {isOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                  <span className="font-medium">v{v.version}</span>
                  <span className="truncate text-muted-foreground">
                    {v.createdBy ? `${v.createdBy} · ` : ""}
                    {formatDate(v.createdAt)}
                    {v.note ? ` · ${v.note}` : ""}
                  </span>
                </button>
                {canWrite && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working !== null}
                    onClick={async () => {
                      try {
                        // groups are not cached with the preview, so always read them with the version
                        const got = await readEnvVersion(session, projectName, environmentName, v.id, envDek);
                        onRestore(got.env, { groups: got.groups, labels: got.labels }, v.version);
                      } catch (err) {
                        fail(err, "Couldn't open that version");
                      }
                    }}
                  >
                    <RotateCcw className="size-4" />
                    Restore
                  </Button>
                )}
                {canDelete && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    tooltip="Delete this version"
                    disabled={working !== null}
                    onClick={() => void remove(v.id, v.version)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>

              {isOpen && (
                <div className="border-t px-3 py-2 text-sm">
                  {!diff ? (
                    <p className="text-muted-foreground">Decrypting…</p>
                  ) : diff.length === 0 ? (
                    <p className="text-muted-foreground">Identical to the current saved version.</p>
                  ) : (
                    <>
                      <p className="mb-2 text-xs text-muted-foreground">
                        Restoring this version would change the current one as follows:
                      </p>
                      <ul className="space-y-1 font-mono text-xs">
                        {diff.map((c) => (
                          <li key={c.key} className="flex flex-wrap items-baseline gap-x-2">
                            <Badge
                              variant={c.kind === "removed" ? "destructive" : c.kind === "added" ? "success" : "outline"}
                            >
                              {KIND_LABEL[c.kind]}
                            </Badge>
                            <span className="font-semibold">{c.key}</span>
                            {showValues && (
                              <span className="break-all text-muted-foreground">
                                {c.kind === "changed"
                                  ? `${c.current} → ${c.version}`
                                  : c.kind === "added"
                                    ? c.version
                                    : `(was ${c.current})`}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
