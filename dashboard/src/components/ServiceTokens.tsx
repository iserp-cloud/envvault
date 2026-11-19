import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import {
  createServiceToken,
  listGrantableEnvironments,
  listServiceAccounts,
  revokeServiceToken,
  type ServiceAccount,
  type Session,
} from "@/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isUnauthorized } from "@/lib/auth-errors";
import { formatDate } from "@/lib/env-rows";
import { useConfirm } from "@/components/ConfirmDialog";
import { Checkbox } from "@/components/ui/checkbox";

type Props = {
  session: Session;
  onAuthFailure: () => void;
};

type Level = "read" | "write";

/** Machine credentials for CI/CD: scoped to chosen environments, expiring, revocable. */
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{1,27}$/;

export function ServiceTokens({ session, onAuthFailure }: Props) {
  const confirm = useConfirm();
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [envs, setEnvs] = useState<Array<{ project: string; env: string }>>([]);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [days, setDays] = useState("90");
  const [level, setLevel] = useState<Level>("read");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; username: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      if (isUnauthorized(err)) return onAuthFailure();
      setError(err instanceof Error ? err.message : fallback);
    },
    [onAuthFailure],
  );

  const refresh = useCallback(async () => {
    try {
      const [a, e] = await Promise.all([
        listServiceAccounts(session, session.activeTenantId),
        listGrantableEnvironments(session),
      ]);
      setAccounts(a);
      setEnvs(e);
    } catch (err) {
      fail(err, "Failed to load service tokens");
    }
  }, [session, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const key = (e: { project: string; env: string }) => `${e.project}\0${e.env}`;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Give the token a name");
      return;
    }
    if (!SERVICE_NAME.test(trimmed)) {
      setNameError("Use 2–28 characters: letters, numbers, _ or -, starting with a letter or number");
      return;
    }
    setNameError(null);
    setBusy(true);
    setError(null);
    setStatus(null);
    setCreated(null);
    setCopied(false);
    try {
      const grants = envs
        .filter((x) => picked.has(key(x)))
        .map((x) => ({ project: x.project, env: x.env, level }));
      setCreated(await createServiceToken(session, { name, expiresInDays: Number(days), grants }));
      setName("");
      setPicked(new Set());
      await refresh();
    } catch (err) {
      fail(err, "Failed to create token");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(username: string) {
    const ok = await confirm({
      title: `Revoke ${username}?`,
      description: "Its token stops working immediately and affected environments are re-keyed.",
      confirmLabel: "Revoke token",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await revokeServiceToken(session, username);
      setStatus(
        `Revoked ${username}${r.rotated ? ` and rotated ${r.rotated} environment key(s)` : ""}` +
          (r.notRotated.length ? `. Could not rotate: ${r.notRotated.join(", ")}` : ""),
      );
      await refresh();
    } catch (err) {
      fail(err, "Revoke failed");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy — select the token and copy it manually");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Terminal className="size-4" />
          Service tokens
        </CardTitle>
        <CardDescription>
          Give CI/CD read access to specific environments without a human login. The token holds its own
          key — the server never sees it — and expires automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {status && <p className="text-sm text-muted-foreground">{status}</p>}

        <form noValidate onSubmit={(e) => void onCreate(e)} className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2 sm:col-span-1">
            <Label htmlFor="svc-name">Name</Label>
            <Input
              id="svc-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              placeholder="ci-deploy"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "svc-name-error" : undefined}
            />
            {nameError && (
              <p id="svc-name-error" role="alert" className="text-xs text-destructive">
                {nameError}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Expires in</Label>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[["30", "30 days"], ["90", "90 days"], ["180", "180 days"], ["365", "1 year"]].map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Access</Label>
            <Select value={level} onValueChange={(v) => setLevel(v as Level)}>
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Read only</SelectItem>
                <SelectItem value="write">Read &amp; write</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 sm:col-span-3">
            <Label>Environments</Label>
            {envs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You can&apos;t share any environments in this workspace yet.
              </p>
            ) : (
              <div className="max-h-44 overflow-y-auto rounded-lg border">
                {envs.map((x) => (
                  <label key={key(x)} className="flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-muted/50">
                    <Checkbox
                      checked={picked.has(key(x))}
                      onCheckedChange={(on) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (on === true) next.add(key(x));
                          else next.delete(key(x));
                          return next;
                        })
                      }
                    />
                    <span className="font-medium">{x.project}</span>
                    <span className="font-mono text-xs text-muted-foreground">{x.env}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="sm:col-span-3">
            <Button type="submit" disabled={busy || !name.trim() || picked.size === 0}>
              {busy ? "Creating…" : "Create token"}
            </Button>
          </div>
        </form>

        {created && (
          <div className="rounded-lg border border-primary/30 bg-accent/50 p-4">
            <p className="text-sm font-medium">Copy this token now — it won&apos;t be shown again.</p>
            <div className="mt-2 flex gap-2">
              <Input readOnly value={created.token} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button type="button" variant="outline" onClick={() => void copy()}>
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Use it in CI as <code className="font-mono">ENVVAULT_TOKEN</code>, then{" "}
              <code className="font-mono">envvault pull -p &lt;project&gt; -e &lt;env&gt;</code>. Expires{" "}
              {formatDate(created.expiresAt)}.
            </p>
          </div>
        )}

        {accounts.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {accounts.map((a) => (
              <li key={a.username} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="font-mono text-sm font-medium">{a.username}</span>
                <Badge variant={a.status === "active" ? "success" : "destructive"}>{a.status}</Badge>
                <span className="text-xs text-muted-foreground">
                  by {a.createdBy ?? "—"} · {a.expiresAt ? `expires ${formatDate(a.expiresAt)}` : "no active token"}
                </span>
                {a.status === "active" && (
                  <Button className="ml-auto" size="sm" variant="ghost" disabled={busy} onClick={() => void onRevoke(a.username)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
