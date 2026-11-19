import { useMemo, useState, type FormEvent } from "react";
import { Pencil, Trash2 } from "lucide-react";
import {
  type AccessEntry,
  grantEnvironmentAccess,
  listEnvironmentAccess,
  prepareGrant,
  revokeEnvironmentAccess,
  type Session,
  type TenantMember,
} from "@/api";
import { MemberCombobox } from "@/components/MemberCombobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  ACL_CAPS,
  CAP_LABELS,
  covers,
  describeAccess,
  effectiveCaps,
  levelAtLeast,
  normalizeGrant,
  type AclCap,
  type AclLevel,
} from "@envvault/shared";

const CAP_HINTS: Record<AclCap, string> = {
  delete: "Delete the environment and its saved versions",
  share: "Give other members access, and see who has it",
  rotate: "Change the key and revoke people's access",
};

type Props = {
  session: Session;
  projectName: string;
  environmentName: string;
  envDek: string;
  /** The key generation `envDek` belongs to, sent back when sharing so a rotated key is refused. */
  keyVersion: number;
  members: TenantMember[];
  accessList: AccessEntry[];
  /** The signed-in user's own access here: what they can see and hand out is limited to it. */
  myLevel: AclLevel;
  myCaps: string;
  ownerUsername?: string;
  busy: boolean;
  onAccessListChange: (list: AccessEntry[]) => void;
  onStatus: (message: string) => void;
  onError: (message: string | null) => void;
  onBusy: (busy: boolean) => void;
  onAuthFailure: () => void;
  /** Called after a key rotation so the parent can re-fetch the new environment key. */
  onRotated: () => Promise<unknown> | void;
};

function isUnauthorized(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unauthorized|invalid auth token|missing auth token/i.test(message);
}

export function ProjectVisibility({
  session,
  projectName,
  environmentName,
  envDek,
  keyVersion,
  members,
  accessList,
  myLevel,
  myCaps,
  ownerUsername,
  busy,
  onAccessListChange,
  onStatus,
  onError,
  onBusy,
  onAuthFailure,
  onRotated,
}: Props) {
  const confirm = useConfirm();
  const [grantUsername, setGrantUsername] = useState("");
  const [grantLevel, setGrantLevel] = useState<AclLevel>("read");
  const [grantCaps, setGrantCaps] = useState<Set<AclCap>>(new Set());
  /** Set while changing an existing member's access instead of adding someone new. */
  const [editing, setEditing] = useState<string | null>(null);

  const mine = useMemo(() => effectiveCaps(myLevel, myCaps), [myLevel, myCaps]);
  const me = { level: myLevel, caps: myCaps };
  const canShare = mine.includes("share");
  const canRotate = mine.includes("rotate");
  const isManager = grantLevel === "manage";

  const exclude = useMemo(
    () => accessList.filter((a) => a.username !== editing).map((a) => a.username),
    [accessList, editing],
  );

  function resetForm() {
    setEditing(null);
    setGrantUsername("");
    setGrantLevel("read");
    setGrantCaps(new Set());
  }

  function startEdit(entry: AccessEntry) {
    setEditing(entry.username);
    setGrantUsername(entry.username);
    setGrantLevel(entry.level);
    setGrantCaps(new Set(entry.caps));
  }

  function toggleCap(cap: AclCap, on: boolean) {
    setGrantCaps((prev) => {
      const next = new Set(prev);
      if (on) next.add(cap);
      else next.delete(cap);
      return next;
    });
  }

  async function onGrant(e: FormEvent) {
    e.preventDefault();
    const username = grantUsername.trim();
    if (!username) return;
    onBusy(true);
    onError(null);
    try {
      // Compare the key the server gave us with what we remember (trust on first use).
      const prepared = await prepareGrant(session, username);
      if (prepared.status !== "match") {
        const changed = prepared.status === "changed";
        const ok = await confirm({
          title: changed
            ? `${prepared.username}'s key has changed`
            : `First time sharing with ${prepared.username}`,
          description: changed
            ? "This may be a legitimate account reset, or the server substituting a key. Only continue if they confirm this exact fingerprint."
            : "Ask them to check it matches (account menu → Key fingerprint).",
          detail: prepared.display,
          confirmLabel: changed ? "Trust new key and share" : "Trust and share",
          destructive: changed,
        });
        if (!ok) return;
      }
      const grant = normalizeGrant(grantLevel, [...grantCaps]);
      await grantEnvironmentAccess(
        session,
        projectName,
        environmentName,
        prepared,
        grant.level,
        envDek,
        keyVersion,
        grant.caps,
      );
      resetForm();
      onAccessListChange(
        await listEnvironmentAccess(session, projectName, environmentName),
      );
      onStatus(`${editing ? "Updated" : "Granted"} ${describeAccess(grant.level, grant.caps)} for ${username}`);
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthFailure();
        return;
      }
      onError(err instanceof Error ? err.message : "Grant failed");
    } finally {
      onBusy(false);
    }
  }

  async function onRevoke(username: string) {
    onBusy(true);
    onError(null);
    try {
      const { droppedVersions } = await revokeEnvironmentAccess(session, projectName, environmentName, username, envDek);
      await onRotated();
      onAccessListChange(
        await listEnvironmentAccess(session, projectName, environmentName),
      );
      onStatus(
        `Revoked ${username} and rotated the environment key` +
          (droppedVersions
            ? `. ${droppedVersions} older saved version${droppedVersions === 1 ? "" : "s"} couldn't be carried over and ${droppedVersions === 1 ? "was" : "were"} dropped.`
            : ""),
      );
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthFailure();
        return;
      }
      onError(err instanceof Error ? err.message : "Revoke failed");
    } finally {
      onBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-1">
      <div>
        <h2 className="font-display text-xl font-semibold">Environment access</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Control who can see and edit{" "}
          <span className="font-medium text-foreground">
            {projectName}/{environmentName}
          </span>
          . You can grant access to invited members before they accept.
        </p>
      </div>

      {canShare ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {editing ? `Change access for ${editing}` : "Grant access"}
            </CardTitle>
            <CardDescription>
              Wraps this environment&apos;s key for the selected member (active or pending invite).
              You can give out no more than you hold yourself.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-5" noValidate onSubmit={(e) => void onGrant(e)}>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-end">
                <div className="grid gap-2">
                  <Label htmlFor="grant-member">Member</Label>
                  <MemberCombobox
                    members={members}
                    value={grantUsername}
                    onChange={setGrantUsername}
                    exclude={exclude}
                    placeholder="Select a member…"
                    disabled={busy || editing !== null}
                    activeOnly={false}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="grant-access">Access</Label>
                  <Select
                    value={grantLevel}
                    onValueChange={(v) => {
                      setGrantLevel(v as AclLevel);
                      if (v === "manage") setGrantCaps(new Set(ACL_CAPS));
                    }}
                  >
                    <SelectTrigger id="grant-access" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read">Read</SelectItem>
                      {levelAtLeast(myLevel, "write") && <SelectItem value="write">Read &amp; write</SelectItem>}
                      {myLevel === "manage" && <SelectItem value="manage">Manager (everything)</SelectItem>}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Also allow</legend>
                {ACL_CAPS.map((cap) => {
                  const held = mine.includes(cap);
                  const id = `grant-cap-${cap}`;
                  return (
                    <label
                      key={cap}
                      htmlFor={id}
                      className={`flex items-start gap-2.5 text-sm ${held && !isManager ? "cursor-pointer" : "opacity-60"}`}
                    >
                      <Checkbox
                        id={id}
                        className="mt-0.5"
                        checked={isManager || grantCaps.has(cap)}
                        disabled={isManager || !held || busy}
                        onCheckedChange={(on) => toggleCap(cap, on === true)}
                      />
                      <span>
                        <span className="font-medium">{CAP_LABELS[cap]}</span>
                        <span className="block text-xs text-muted-foreground">
                          {held ? CAP_HINTS[cap] : "You don't have this permission yourself"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>

              <div className="flex gap-2">
                <Button type="submit" className="h-9" disabled={busy || !grantUsername}>
                  {editing ? "Save changes" : "Grant"}
                </Button>
                {editing && (
                  <Button type="button" variant="outline" className="h-9" disabled={busy} onClick={resetForm}>
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <p className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          You can see who has access, but you don&apos;t have the share permission, so you can&apos;t
          change it.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Who has access</CardTitle>
          <CardDescription>
            {accessList.length} user{accessList.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {accessList.length === 0 ? (
            <p className="text-sm text-muted-foreground">No access grants yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {accessList.map((a) => (
                <li
                  key={a.username}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-medium">{a.username}</span>
                    <Badge variant="secondary">{describeAccess(a.level, a.caps)}</Badge>
                  </div>
                  {a.username !== ownerUsername && covers(me, a) && (
                    <div className="flex shrink-0 gap-0.5">
                      {canShare && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          tooltip="Change access"
                          disabled={busy}
                          onClick={() => startEdit(a)}
                        >
                          <Pencil />
                        </Button>
                      )}
                      {canRotate && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          tooltip="Revoke access"
                          disabled={busy}
                          onClick={() => void onRevoke(a.username)}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
