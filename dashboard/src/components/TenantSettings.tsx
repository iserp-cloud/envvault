import { useState, type FormEvent } from "react";
import { Building2, Trash2, UserPlus, UserMinus } from "lucide-react";
import {
  createOrgTenant,
  deleteOrgTenant,
  inviteToTenant,
  removeTenantMember,
  type Session,
  type TenantMember,
  type TenantMeta,
} from "@/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActivityLog } from "@/components/ActivityLog";
import { ServiceTokens } from "@/components/ServiceTokens";
import { Sessions } from "@/components/Sessions";
import { validateHandle } from "@envvault/shared";
import { useConfirm } from "@/components/ConfirmDialog";

type Props = {
  session: Session;
  activeTenant: TenantMeta | undefined;
  members: TenantMember[];
  canInvite: boolean;
  busy: boolean;
  onMembersChange: (members: TenantMember[]) => void;
  onStatus: (message: string) => void;
  onError: (message: string | null) => void;
  onBusy: (busy: boolean) => void;
  onAuthFailure: () => void;
  listMembers: () => Promise<TenantMember[]>;
  onOrgCreated: (tenantId: string) => void | Promise<void>;
  onOrgDeleted: () => void | Promise<void>;
};

function isUnauthorized(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unauthorized|invalid auth token|missing auth token/i.test(message);
}

export function TenantSettings({
  session,
  activeTenant,
  members,
  canInvite,
  busy,
  onMembersChange,
  onStatus,
  onError,
  onBusy,
  onAuthFailure,
  listMembers,
  onOrgCreated,
  onOrgDeleted,
}: Props) {
  const confirm = useConfirm();
  const [inviteUsername, setInviteUsername] = useState("");
  const [orgName, setOrgName] = useState("");
  const [confirmSlug, setConfirmSlug] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const isPersonal = activeTenant?.kind === "personal";
  const isOwner = activeTenant?.role === "owner";
  const isManager = activeTenant?.role === "owner" || activeTenant?.role === "admin";
  const orgSlug = activeTenant?.slug ?? activeTenant?.name ?? "";

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    const username = inviteUsername.trim();
    if (!canInvite) return;
    const invalid = validateHandle(username);
    setInviteError(invalid);
    if (invalid) return;
    onBusy(true);
    onError(null);
    try {
      await inviteToTenant(session, session.activeTenantId, username);
      setInviteUsername("");
      onMembersChange(await listMembers());
      onStatus(`Invited ${username}`);
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthFailure();
        return;
      }
      onError(err instanceof Error ? err.message : "Invite failed");
    } finally {
      onBusy(false);
    }
  }

  async function onCreateOrg(e: FormEvent) {
    e.preventDefault();
    const name = orgName.trim();
    const invalid = validateHandle(name, "Organization name");
    setOrgError(invalid);
    if (invalid) return;
    onBusy(true);
    onError(null);
    try {
      const org = await createOrgTenant(session, name);
      setOrgName("");
      onStatus(`Organization "${org.name}" created`);
      await onOrgCreated(org.id);
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthFailure();
        return;
      }
      onError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      onBusy(false);
    }
  }

  async function onRemove(member: TenantMember) {
    if (!canInvite) return;
    const pending = member.status === "pending";
    const ok = await confirm({
      title: pending
        ? `Revoke invite for ${member.username}?`
        : `Remove ${member.username}?`,
      description: pending ? undefined : "They lose access to this organization's projects.",
      confirmLabel: pending ? "Revoke invite" : "Remove member",
      destructive: true,
    });
    if (!ok) return;

    onBusy(true);
    onError(null);
    try {
      const result = await removeTenantMember(
        session,
        session.activeTenantId,
        member.username,
      );
      onMembersChange(await listMembers());
      if (result.notRotated.length > 0) {
        onError(
          `Removed ${member.username}, but could not rotate keys for: ${result.notRotated.join(", ")}. ` +
            "Ask someone with manage access to revoke and re-grant those environments.",
        );
      }
      onStatus(
        result.wasPending
          ? `Revoked invite for ${member.username}`
          : result.rotated > 0
            ? `Removed ${member.username} and rotated ${result.rotated} environment key(s)`
            : `Removed ${member.username}`,
      );
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthFailure();
        return;
      }
      onError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      onBusy(false);
    }
  }

  function canRemoveMember(m: TenantMember): boolean {
    if (!canInvite) return false;
    if (m.username === activeTenant?.ownerUsername) return false;
    if (m.username === session.username) return false;
    if (activeTenant?.role === "admin" && m.role === "admin") return false;
    return true;
  }

  async function onDeleteOrg(e: FormEvent) {
    e.preventDefault();
    if (!isOwner || isPersonal || !activeTenant) return;
    if (confirmSlug.trim().toLowerCase() !== orgSlug.toLowerCase()) {
      onError(`Type “${orgSlug}” to confirm deletion`);
      return;
    }
    const ok = await confirm({
      title: `Delete organization “${orgSlug}”?`,
      description: "All projects and member access will be permanently removed.",
      confirmLabel: "Delete organization",
      destructive: true,
    });
    if (!ok) return;

    onBusy(true);
    onError(null);
    try {
      await deleteOrgTenant(session, activeTenant.id);
      setConfirmSlug("");
      onStatus(`Deleted organization ${orgSlug}`);
      await onOrgDeleted();
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthFailure();
        return;
      }
      onError(err instanceof Error ? err.message : "Failed to delete organization");
    } finally {
      onBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isPersonal
            ? "Your personal vault is private to you. Create an organization to share projects."
            : (
              <>
                Manage members for{" "}
                <span className="font-medium text-foreground">
                  {activeTenant?.name ?? "this organization"}
                </span>
                .
              </>
            )}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4" />
            Create organization
          </CardTitle>
          <CardDescription>
            Globally unique handle (like a username) — cannot match an existing user or
            organization. Up to 10 orgs per account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => void onCreateOrg(e)}
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                value={orgName}
                onChange={(e) => {
                  setOrgName(e.target.value);
                  setOrgError(null);
                }}
                aria-invalid={Boolean(orgError)}
                placeholder="acme"
                autoComplete="off"
                spellCheck={false}
              />
              {orgError && (
                <p role="alert" className="text-xs text-destructive">
                  {orgError}
                </p>
              )}
            </div>
            <Button type="submit" disabled={busy || !orgName.trim()}>
              Create
            </Button>
          </form>
        </CardContent>
      </Card>

      {isPersonal ? (
        <Alert>
          <AlertDescription>
            Personal vaults cannot invite members. Switch to an organization (or create one)
            to collaborate.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {canInvite && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <UserPlus className="size-4" />
                  Invite member
                </CardTitle>
                <CardDescription>
                  Exact username only — the user must already have an account.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  noValidate
                  className="flex flex-col gap-3 sm:flex-row sm:items-end"
                  onSubmit={(e) => void onInvite(e)}
                >
                  <div className="flex-1 space-y-2">
                    <Label htmlFor="invite-username">Username</Label>
                    <Input
                      id="invite-username"
                      value={inviteUsername}
                      onChange={(e) => {
                        setInviteUsername(e.target.value);
                        setInviteError(null);
                      }}
                      aria-invalid={Boolean(inviteError)}
                      placeholder="alice"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {inviteError && (
                      <p role="alert" className="text-xs text-destructive">
                        {inviteError}
                      </p>
                    )}
                  </div>
                  <Button type="submit" disabled={busy || !inviteUsername.trim()}>
                    Invite
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}

          {!canInvite && (
            <Alert>
              <AlertDescription>
                Only organization owners and admins can invite members.
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Members</CardTitle>
              <CardDescription>
                {members.length} member{members.length === 1 ? "" : "s"}
                {canInvite ? " — revoke pending invites or remove members" : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {members.length === 0 ? (
                <p className="text-sm text-muted-foreground">No members yet.</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {members.map((m) => (
                    <li
                      key={m.username}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <span className="font-medium">{m.username}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{m.role}</Badge>
                        <Badge variant={m.status === "active" ? "success" : "outline"}>
                          {m.status}
                        </Badge>
                        {canRemoveMember(m) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={busy}
                            tooltip={
                              m.status === "pending" ? "Revoke invite" : "Remove member"
                            }
                            onClick={() => void onRemove(m)}
                          >
                            <UserMinus className="size-4" />
                            {m.status === "pending" ? "Revoke" : "Remove"}
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {isOwner && (
            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-destructive">
                  <Trash2 className="size-4" />
                  Delete organization
                </CardTitle>
                <CardDescription>
                  Permanently deletes {orgSlug}, all projects, and member access. This cannot
                  be undone. Type the organization name to confirm.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  noValidate
                  className="flex flex-col gap-3 sm:flex-row sm:items-end"
                  onSubmit={(e) => void onDeleteOrg(e)}
                >
                  <div className="flex-1 space-y-2">
                    <Label htmlFor="confirm-delete-org">Confirm name</Label>
                    <Input
                      id="confirm-delete-org"
                      value={confirmSlug}
                      onChange={(e) => setConfirmSlug(e.target.value)}
                      placeholder={orgSlug}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={
                      busy || confirmSlug.trim().toLowerCase() !== orgSlug.toLowerCase()
                    }
                  >
                    Delete organization
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Sessions session={session} onAuthFailure={onAuthFailure} />

      {isManager && activeTenant && (
        <>
          <ServiceTokens key={activeTenant.id} session={session} onAuthFailure={onAuthFailure} />
          <ActivityLog
            key={`audit-${activeTenant.id}`}
            session={session}
            scope="workspace"
            tenantId={activeTenant.id}
            title="Workspace activity"
          />
        </>
      )}
    </div>
  );
}
