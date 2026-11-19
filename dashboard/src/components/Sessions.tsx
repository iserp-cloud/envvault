import { useCallback, useEffect, useState } from "react";
import { Laptop } from "lucide-react";
import {
  listSessions,
  revokeOtherSessions,
  revokeSession,
  type SessionInfo,
  type Session,
} from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isUnauthorized } from "@/lib/auth-errors";
import { formatDate } from "@/lib/env-rows";

type Props = { session: Session; onAuthFailure: () => void };

/** Turn a User-Agent into something a person recognises. */
function describeAgent(ua: string): string {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /envvault/i.test(ua) ? "CLI" : ua.split(" ")[0]!.split("/")[0]!;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function Sessions({ session, onAuthFailure }: Props) {
  const [rows, setRows] = useState<SessionInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await listSessions(session));
    } catch (err) {
      if (isUnauthorized(err)) return onAuthFailure();
      setError(err instanceof Error ? err.message : "Failed to load devices");
    }
  }, [session, onAuthFailure]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      if (isUnauthorized(err)) return onAuthFailure();
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const others = rows.filter((r) => !r.current).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Laptop className="size-4" />
          Signed-in devices
        </CardTitle>
        <CardDescription>
          Places your account is signed in. Revoke anything you don&apos;t recognise — then change
          your password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <ul className="divide-y rounded-lg border">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {describeAgent(r.userAgent)}
                  {r.current && (
                    <Badge variant="success" className="ml-2">
                      this device
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.ip && r.ip !== "unknown" ? `${r.ip} · ` : ""}signed in {formatDate(r.createdAt)} · expires{" "}
                  {formatDate(r.expiresAt)}
                </p>
              </div>
              {!r.current && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => revokeSession(session, r.id))}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
        {others > 0 && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => revokeOtherSessions(session))}>
            Sign out all other devices
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
