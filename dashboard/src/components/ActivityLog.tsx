import { useCallback, useEffect, useState } from "react";
import { listAudit, verifyAuditLog, type AuditEvent, type Session } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/env-rows";

type Props = {
  session: Session;
  scope: "instance" | "workspace";
  tenantId?: string;
  title?: string;
  description?: string;
};

const PAGE = 50;

/** Colour-code by how sensitive the action is. */
function tone(action: string): "destructive" | "success" | "secondary" | "outline" {
  if (/delete|revoke|remove|disable|failed|rotate/.test(action)) return "destructive";
  if (/read|login$|signup|create|grant|accept/.test(action)) return "secondary";
  return "outline";
}

export function ActivityLog({
  session,
  scope,
  tenantId,
  title = "Activity",
  description = "Who did what, and when. Values are never recorded.",
}: Props) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      setError(null);
      try {
        const rows = await listAudit(session, { scope, tenantId, before, limit: PAGE });
        setEvents((prev) => (before ? [...prev, ...rows] : rows));
        setMore(rows.length === PAGE);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load activity");
      } finally {
        setLoading(false);
      }
    },
    [session, scope, tenantId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex gap-2">
            {scope === "instance" && (
              <Button
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() =>
                  void verifyAuditLog(session)
                    .then((r) =>
                      setIntegrity(
                        r.invalid > 0
                          ? `⚠ ${r.invalid} of ${r.checked} entries failed verification — they were modified after being written.`
                          : `✓ ${r.checked - r.unsigned} of ${r.checked} recent entries verified${r.unsigned ? ` (${r.unsigned} older entries are unsigned)` : ""}.`,
                      ),
                    )
                    .catch((err) => setError(err instanceof Error ? err.message : "Verification failed"))
                }
              >
                Verify integrity
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
        {integrity && <p className="mb-3 text-sm">{integrity}</p>}
        {events.length === 0 && !loading && !error ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <Badge variant={tone(e.action)} className="font-mono">
                  {e.action}
                </Badge>
                <span className="font-medium">{e.actor || "—"}</span>
                {e.target && <span className="font-mono text-xs text-muted-foreground">{e.target}</span>}
                {e.detail && <span className="text-xs text-muted-foreground">({e.detail})</span>}
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatDate(e.at)}
                  {e.ip && e.ip !== "unknown" ? ` · ${e.ip}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {more && (
          <Button
            className="mt-3"
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void load(events[events.length - 1]?.at)}
          >
            Load older
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
