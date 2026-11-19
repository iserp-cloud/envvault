import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, Link2, ShieldCheck, UserX, UserCheck } from "lucide-react";
import {
  adminCreateInvite,
  adminListInvites,
  adminListUsers,
  adminRevokeInvite,
  adminSetUserRole,
  adminSetUserStatus,
  type AdminInvite,
  type AdminUser,
  type Session,
  type TenantMeta,
} from "@/api";
import { ActivityLog } from "@/components/ActivityLog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isUnauthorized } from "@/lib/auth-errors";
import { formatDate } from "@/lib/env-rows";

type Props = {
  session: Session;
  tenants: TenantMeta[];
  onAuthFailure: () => void;
};

const EXPIRY: Array<[string, string]> = [
  ["24", "1 day"],
  ["72", "3 days"],
  ["168", "7 days"],
  ["720", "30 days"],
];

const STATE_VARIANT = {
  active: "success",
  used: "secondary",
  revoked: "destructive",
  expired: "outline",
} as const;

export function AdminPage({ session, tenants, onAuthFailure }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [expiry, setExpiry] = useState("72");
  const [tenantId, setTenantId] = useState("none");
  const [tenantRole, setTenantRole] = useState<"member" | "admin">("member");
  const [created, setCreated] = useState<{ link: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Workspaces this admin may invite people into.
  const inviteTargets = tenants.filter(
    (t) => t.kind === "org" && (t.role === "owner" || t.role === "admin"),
  );

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      if (isUnauthorized(err)) return onAuthFailure();
      setError(err instanceof Error ? err.message : fallback);
    },
    [onAuthFailure],
  );

  const refresh = useCallback(async () => {
    try {
      const [u, i] = await Promise.all([adminListUsers(session), adminListInvites(session)]);
      setUsers(u);
      setInvites(i);
    } catch (err) {
      fail(err, "Failed to load administration data");
    }
  }, [session, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      fail(err, fallback);
    } finally {
      setBusy(false);
    }
  }

  async function onCreateInvite(e: FormEvent) {
    e.preventDefault();
    setCreated(null);
    setCopied(false);
    await run(async () => {
      const result = await adminCreateInvite(session, {
        expiresInHours: Number(expiry),
        note: note.trim(),
        ...(tenantId !== "none" ? { tenantId, tenantRole } : {}),
      });
      setCreated({ link: result.link, expiresAt: result.expiresAt });
      setNote("");
    }, "Failed to create invite");
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy — select the link and copy it manually");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Invite people and manage who can sign in to this server.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Invite someone</CardTitle>
          <CardDescription>
            Each link works once and expires. The person chooses their own password in their
            browser — you never see it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={(e) => void onCreateInvite(e)} className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="invite-note">Note (optional)</Label>
              <Input
                id="invite-note"
                value={note}
                maxLength={120}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Sam from the payments team"
              />
            </div>
            <div className="space-y-2">
              <Label>Expires in</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY.map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Also invite to workspace</Label>
              <Select value={tenantId} onValueChange={setTenantId}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {inviteTargets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.slug || t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {tenantId !== "none" && (
              <div className="space-y-2">
                <Label>Workspace role</Label>
                <Select
                  value={tenantRole}
                  onValueChange={(v) => setTenantRole(v as "member" | "admin")}
                >
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex items-end sm:col-span-2">
              <Button type="submit" disabled={busy}>
                <Link2 />
                Create invite link
              </Button>
            </div>
          </form>

          {created && (
            <div className="rounded-lg border border-primary/30 bg-accent/50 p-4">
              <p className="text-sm font-medium">
                Share this link — it won&apos;t be shown again.
              </p>
              <div className="mt-2 flex gap-2">
                <Input readOnly value={created.link} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
                <Button type="button" variant="outline" onClick={() => void copyLink()}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Expires {formatDate(created.expiresAt)}
              </p>
            </div>
          )}

          {invites.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {invites.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Badge variant={STATE_VARIANT[inv.state]}>{inv.state}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{inv.note || "Invite"}</p>
                    <p className="text-xs text-muted-foreground">
                      {inv.state === "used" && inv.usedBy
                        ? `Joined as ${inv.usedBy} · `
                        : ""}
                      by {inv.createdBy} · expires {formatDate(inv.expiresAt)}
                    </p>
                  </div>
                  {inv.state === "active" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void run(() => adminRevokeInvite(session, inv.id), "Revoke failed")}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Disabling a user signs them out everywhere and blocks sign-in. Their encrypted data
            stays; revoke their workspace access to rotate keys.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-lg border">
            {users.map((u) => {
              const self = u.username === session.username;
              return (
                <li key={u.username} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="grid size-8 place-items-center rounded-full bg-primary/15 text-xs font-semibold uppercase text-primary">
                    {u.username.slice(0, 2)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {u.username}
                      {self && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">Joined {formatDate(u.createdAt)}</p>
                  </div>
                  {u.kind === "service" && <Badge variant="secondary">service</Badge>}
                  {u.role === "admin" && <Badge variant="outline">admin</Badge>}
                  {u.status === "disabled" && <Badge variant="destructive">disabled</Badge>}
                  {!self && u.kind === "user" && (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              adminSetUserRole(session, u.username, u.role === "admin" ? "member" : "admin"),
                            "Role change failed",
                          )
                        }
                      >
                        <ShieldCheck />
                        {u.role === "admin" ? "Remove admin" : "Make admin"}
                      </Button>
                      <Button
                        size="sm"
                        variant={u.status === "active" ? "destructive" : "ghost"}
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              adminSetUserStatus(
                                session,
                                u.username,
                                u.status === "active" ? "disabled" : "active",
                              ),
                            "Status change failed",
                          )
                        }
                      >
                        {u.status === "active" ? <UserX /> : <UserCheck />}
                        {u.status === "active" ? "Disable" : "Enable"}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <ActivityLog
        session={session}
        scope="instance"
        title="Server activity"
        description="Sign-ins, access changes, invites and secret reads across the whole server."
      />
    </div>
  );
}
