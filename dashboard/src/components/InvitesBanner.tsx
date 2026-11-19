import { acceptInvite, declineInvite, type Session, type TenantInvite } from "@/api";
import { Button } from "@/components/ui/button";

type Props = {
  invites: TenantInvite[];
  session: Session;
  busy: boolean;
  onAccepted: (tenantId: string) => Promise<void>;
  onDeclined: () => Promise<void>;
  onError: (message: string) => void;
};

export function InvitesBanner({
  invites,
  session,
  busy,
  onAccepted,
  onDeclined,
  onError,
}: Props) {
  if (invites.length === 0) return null;
  const fail = (fallback: string) => (err: unknown) =>
    onError(err instanceof Error ? err.message : fallback);

  return (
    <div className="border-b bg-accent/40 px-4 py-3">
      <div className="mx-auto flex max-w-5xl flex-col gap-2">
        {invites.map((inv) => (
          <div
            key={inv.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
          >
            <p className="text-sm">
              Invite to <span className="font-semibold">{inv.name}</span> from{" "}
              {inv.ownerUsername}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void acceptInvite(session, inv.id)
                    .then(() => onAccepted(inv.id))
                    .catch(fail("Accept failed"))
                }
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void declineInvite(session, inv.id)
                    .then(() => onDeclined())
                    .catch(fail("Decline failed"))
                }
              >
                Decline
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
