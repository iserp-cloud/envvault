import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Check, Copy, Plus, Unlink } from "lucide-react";
import {
  connectCluster,
  extendCluster,
  linkEnvironment,
  setLinkAdopt,
  listClusters,
  listK8sLinks,
  replaceCluster,
  unlinkEnvironment,
  type K8sCluster,
  type K8sLink,
  type Session,
} from "@/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isUnauthorized } from "@/lib/auth-errors";
import { formatDate } from "@/lib/env-rows";
import { useConfirm } from "@/components/ConfirmDialog";

type Props = {
  session: Session;
  projectName: string;
  environmentName: string;
  envDek: string;
  keyVersion: number;
  canShare: boolean;
  onStatus: (message: string | null) => void;
  onAuthFailure: () => void;
};

const CLUSTER_NAME = /^[a-z0-9][a-z0-9-]{0,20}$/;
const SECRET_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const SEEN_RECENTLY_MS = 2 * 60_000;
const EXPIRY_WARNING_MS = 30 * 86_400_000;

/** A Secret name that is valid by construction, so the common case needs no typing. */
function suggestSecretName(project: string, env: string): string {
  const base = `${project}-${env}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return base.slice(0, 63) || "envvault";
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const isConnected = (c: K8sCluster) =>
  c.expiresAt !== null && Date.parse(c.expiresAt) > Date.now() && c.lastSeen !== null && Date.now() - Date.parse(c.lastSeen) < SEEN_RECENTLY_MS;

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex gap-2">
        <Input readOnly value={text} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label={label} />
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/** Link this environment to a Kubernetes Secret, in either direction, from the dashboard. */
export function KubernetesLinks({ session, projectName, environmentName, envDek, keyVersion, canShare, onStatus, onAuthFailure }: Props) {
  const confirm = useConfirm();
  const [clusters, setClusters] = useState<K8sCluster[] | null>(null);
  const [links, setLinks] = useState<K8sLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [clusterName, setClusterName] = useState("main");
  const [created, setCreated] = useState<{
    token: string;
    username: string;
    expiresAt: string;
    replaced?: boolean;
  } | null>(null);

  const [cluster, setCluster] = useState("");
  const [direction, setDirection] = useState<"pull" | "push">("pull");
  const [adopt, setAdopt] = useState(false);
  const [adding, setAdding] = useState(false);
  const [namespace, setNamespace] = useState("");
  const [secretName, setSecretName] = useState(() => suggestSecretName(projectName, environmentName));

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      if (isUnauthorized(err)) return onAuthFailure();
      setError(err instanceof Error ? err.message : fallback);
    },
    [onAuthFailure],
  );

  const refresh = useCallback(async () => {
    try {
      const [c, l] = await Promise.all([listClusters(session), listK8sLinks(session, projectName, environmentName)]);
      setClusters(c.filter((x) => x.status === "active"));
      setLinks(l);
    } catch (err) {
      fail(err, "Could not load Kubernetes links");
    }
  }, [session, projectName, environmentName, fail]);

  // Poll while open: this is how the page notices the operator connecting and reporting.
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    setSecretName(suggestSecretName(projectName, environmentName));
  }, [projectName, environmentName]);

  // One Secret may push into an environment: two would overwrite each other's keys. The hub enforces it too.
  const pushLink = links.find((l) => l.direction === "push");
  useEffect(() => {
    if (pushLink && direction === "push") setDirection("pull");
  }, [pushLink, direction]);

  const active = clusters?.find((c) => c.cluster === cluster) ?? clusters?.[0];
  useEffect(() => {
    if (active && active.cluster !== cluster) setCluster(active.cluster);
  }, [active, cluster]);

  async function onConnect(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!CLUSTER_NAME.test(clusterName)) {
      setError("Use lowercase letters, digits and dashes for the cluster name.");
      return;
    }
    setBusy(true);
    try {
      setCreated(await connectCluster(session, clusterName));
      await refresh();
    } catch (err) {
      fail(err, "Could not connect the cluster");
    } finally {
      setBusy(false);
    }
  }

  async function onExtend(c: K8sCluster) {
    setBusy(true);
    setError(null);
    try {
      const { expiresAt } = await extendCluster(session, c.cluster);
      onStatus(`Token extended to ${formatDate(expiresAt)}. Nothing to change in the cluster.`);
      await refresh();
    } catch (err) {
      fail(err, "Could not extend the token");
    } finally {
      setBusy(false);
    }
  }

  async function onReplace(c: K8sCluster) {
    const ok = await confirm({
      title: "Replace the expired token?",
      description:
        "A new token is made with access to the same environments and the links move to it. You then put it in the cluster in place of the old one; until then nothing syncs. Secrets already in the cluster are not touched.",
      confirmLabel: "Replace token",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await replaceCluster(session, c.cluster);
      setCreated({ ...fresh, replaced: true });
      await refresh();
    } catch (err) {
      fail(err, "Could not replace the token");
    } finally {
      setBusy(false);
    }
  }

  async function onLink(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!active) return;
    if (!SECRET_NAME.test(secretName)) {
      setError("That is not a valid Secret name (lowercase letters, digits, dashes and dots).");
      return;
    }
    if (!namespace.trim()) {
      setError("Pick the namespace the Secret lives in.");
      return;
    }
    // Checked before anything is granted: the operator says which namespaces it may use.
    if (active.namespaces.length > 0 && !active.namespaces.includes(namespace.trim())) {
      setError(`The operator on this cluster may not use the namespace "${namespace.trim()}". Allowed: ${active.namespaces.join(", ")}.`);
      return;
    }
    setBusy(true);
    try {
      await linkEnvironment(session, {
        project: projectName,
        env: environmentName,
        envDek,
        keyVersion,
        cluster: active.cluster,
        namespace: namespace.trim(),
        secretName,
        direction,
        adopt: direction === "pull" && adopt,
      });
      onStatus(
        direction === "pull"
          ? `Linked. ${namespace}/${secretName} will be created within about half a minute.`
          : `Linked. Keys in ${namespace}/${secretName} will be pushed to ${environmentName}.`,
      );
      setAdding(false);
      await refresh();
    } catch (err) {
      fail(err, "Could not link");
    } finally {
      setBusy(false);
    }
  }

  async function onTakeOver(link: K8sLink) {
    const ok = await confirm({
      title: `Take over ${link.namespace}/${link.secretName}?`,
      description:
        "The Secret already exists in the cluster. Its current contents are replaced by this environment's values, and the operator keeps it in step from then on.",
      confirmLabel: "Take over",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await setLinkAdopt(session, link.id, true);
      onStatus("The operator will take the Secret over within about half a minute");
      await refresh();
    } catch (err) {
      fail(err, "Could not take over");
    } finally {
      setBusy(false);
    }
  }

  async function onUnlink(link: K8sLink) {
    const ok = await confirm({
      title: `Unlink ${link.namespace}/${link.secretName}?`,
      description:
        link.direction === "pull"
          ? "The Secret stays in the cluster with its current values, but stops being updated."
          : "Nothing is deleted on either side. The Secret stops being pushed.",
      confirmLabel: "Unlink",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await unlinkEnvironment(session, link.id);
      onStatus("Unlinked");
      await refresh();
    } catch (err) {
      fail(err, "Could not unlink");
    } finally {
      setBusy(false);
    }
  }

  if (!canShare) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Kubernetes</CardTitle>
          <CardDescription>You need permission to share this environment to link it to a cluster.</CardDescription>
        </CardHeader>
        {links.length > 0 && (
          <CardContent>
            <LinkList links={links} busy onUnlink={() => undefined} readOnly />
          </CardContent>
        )}
      </Card>
    );
  }

  const namespaces = active?.namespaces ?? [];
  const expired = (c: K8sCluster) => c.expiresAt === null || Date.parse(c.expiresAt) <= Date.now();
  const soon = (c: K8sCluster) => c.expiresAt !== null && Date.parse(c.expiresAt) - Date.now() < EXPIRY_WARNING_MS;

  const clusterStatus = clusters && clusters.length > 0 && (
    <ul className="space-y-1">
      {clusters.map((c) => (
        <li key={c.cluster} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono">{c.cluster.replace(/^svc-k8s-/, "")}</span>
          <Badge variant={isConnected(c) ? "success" : "outline"}>
            {isConnected(c) ? "Operator connected" : c.lastSeen ? `Last seen ${ago(c.lastSeen)}` : "Waiting for the operator"}
          </Badge>
          {c.version && <span className="text-xs text-muted-foreground">v{c.version}</span>}
          {expired(c) ? (
            <>
              <Badge variant="destructive">Token expired</Badge>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onReplace(c)}>
                Replace token
              </Button>
            </>
          ) : (
            soon(c) &&
            c.expiresAt && (
              <>
                <Badge variant="destructive">Token expires {formatDate(c.expiresAt)}</Badge>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onExtend(c)}>
                  Extend a year
                </Button>
              </>
            )
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {clusters !== null && clusters.length === 0 && !created && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connect a cluster</CardTitle>
            <CardDescription>
              Once per cluster. You install the operator with a token made here; after that every link is a few clicks and needs no kubectl. Secret values are
              decrypted inside your cluster, never by the hub.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form noValidate onSubmit={(e) => void onConnect(e)} className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <Label htmlFor="k8s-cluster-name">Cluster name</Label>
                <Input id="k8s-cluster-name" value={clusterName} onChange={(e) => setClusterName(e.target.value.toLowerCase())} placeholder="main" />
              </div>
              <Button type="submit" disabled={busy || !clusterName}>
                {busy ? "Connecting…" : "Connect cluster"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {created && (
        <Card className="border-primary/30 bg-accent/50">
          <CardHeader>
            <CardTitle className="text-base">{created.replaced ? "Put the new token in the cluster" : "Install the operator"}</CardTitle>
            <CardDescription>
              Copy this now: the token is shown once.{" "}
              {created.replaced ? "The links already use it; they resume as soon as the operator reads it." : "This page notices when the operator connects."}{" "}
              Token expires {formatDate(created.expiresAt)}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <CopyBlock
              label={created.replaced ? "Replace the token in the cluster" : "1. Put the token in the cluster"}
              text={
                created.replaced
                  ? `kubectl -n envvault-system create secret generic envvault-cluster-token --from-literal=token='${created.token}' --dry-run=client -o yaml | kubectl apply -f -`
                  : `kubectl -n envvault-system create secret generic envvault-cluster-token --from-literal=token='${created.token}'`
              }
            />
            {!created.replaced && (
              <>
                <CopyBlock label="2. Install the operator" text="kubectl apply -f operator/config/install.yaml" />
                <p className="text-xs text-muted-foreground">
                  Optional: to limit the namespaces links may use, or to give the operator the hub&apos;s in-cluster address and certificate fingerprint, create
                  the <code className="font-mono">envvault-config</code> ConfigMap (see{" "}
                  <code className="font-mono">operator/config/examples/envvault-config.yaml</code>
                  ). Without it every namespace is allowed and the operator uses the address in the token. Changes to it apply within about 30 seconds, with no
                  restart.
                </p>
              </>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => setCreated(null)}>
              I&apos;ve saved it
            </Button>
          </CardContent>
        </Card>
      )}

      {clusters !== null && clusters.length > 0 && (
        <>
          {links.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Linked to {environmentName}</CardTitle>
                <CardDescription>
                  These are working now; there is nothing more to set up for them. Add another link for a different Secret, namespace or direction.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {clusterStatus}
                <LinkList links={links} busy={busy} onUnlink={(l) => void onUnlink(l)} onTakeOver={(l) => void onTakeOver(l)} />
                {!adding && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
                    <Plus /> Add link
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {(adding || links.length === 0) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{links.length > 0 ? "Add a link" : "Link to a Secret"}</CardTitle>
                <CardDescription>Pick a direction, a namespace and a Secret name. The Secret is created for you when it comes from the hub.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {links.length === 0 && clusterStatus}

                <form noValidate onSubmit={(e) => void onLink(e)} className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Direction</Label>
                    <div className="flex gap-2" role="radiogroup" aria-label="Direction">
                      <Button
                        type="button"
                        role="radio"
                        aria-checked={direction === "pull"}
                        variant={direction === "pull" ? "secondary" : "outline"}
                        onClick={() => setDirection("pull")}
                      >
                        Vault <ArrowRight /> Secret
                      </Button>
                      <Button
                        type="button"
                        role="radio"
                        aria-checked={direction === "push"}
                        variant={direction === "push" ? "secondary" : "outline"}
                        disabled={!!pushLink}
                        title={pushLink ? `Already receiving from ${pushLink.namespace}/${pushLink.secretName}` : undefined}
                        onClick={() => setDirection("push")}
                      >
                        Secret <ArrowRight /> Vault
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {direction === "pull"
                        ? "The operator creates the Secret and keeps it in step with this environment."
                        : "The Secret wins for the keys it has: they are added here or overwritten. Keys it doesn't have are left alone; nothing is deleted."}
                      {pushLink &&
                        ` Secret → Vault is off: this environment already receives from ${pushLink.namespace}/${pushLink.secretName}, and only one Secret can push into an environment. Unlink it to use another.`}
                    </p>
                  </div>

                  {clusters.length > 1 && (
                    <div className="space-y-2">
                      <Label>Cluster</Label>
                      <Select value={active?.cluster} onValueChange={setCluster}>
                        <SelectTrigger className="h-9 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {clusters.map((c) => (
                            <SelectItem key={c.cluster} value={c.cluster}>
                              {c.cluster.replace(/^svc-k8s-/, "")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="k8s-ns">Namespace</Label>
                    {namespaces.length > 0 ? (
                      <Select value={namespace} onValueChange={setNamespace}>
                        <SelectTrigger id="k8s-ns" className="h-9 w-full">
                          <SelectValue placeholder="Choose…" />
                        </SelectTrigger>
                        <SelectContent>
                          {namespaces.map((n) => (
                            <SelectItem key={n} value={n}>
                              {n}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input id="k8s-ns" value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="prod" />
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="k8s-secret">Secret name</Label>
                    <Input id="k8s-secret" value={secretName} onChange={(e) => setSecretName(e.target.value)} className="font-mono text-sm" />
                  </div>

                  {direction === "pull" && (
                    <label className="flex cursor-pointer items-start gap-2.5 text-sm sm:col-span-2">
                      <Checkbox checked={adopt} onCheckedChange={(on) => setAdopt(on === true)} className="mt-0.5" />
                      <span>
                        Take over this Secret if it already exists
                        <span className="block text-xs text-muted-foreground">
                          Off by default: the operator never overwrites a Secret it did not create. Turn it on to replace an existing Secret's contents with
                          this environment's values.
                        </span>
                      </span>
                    </label>
                  )}

                  <div className="flex gap-2 sm:col-span-2">
                    <Button type="submit" disabled={busy || !namespace}>
                      {busy ? "Linking…" : "Link"}
                    </Button>
                    {links.length > 0 && (
                      <Button type="button" variant="ghost" disabled={busy} onClick={() => setAdding(false)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function LinkList({
  links,
  busy,
  onUnlink,
  onTakeOver,
  readOnly,
}: {
  links: K8sLink[];
  busy: boolean;
  onUnlink: (l: K8sLink) => void;
  onTakeOver?: (l: K8sLink) => void;
  readOnly?: boolean;
}) {
  return (
    <ul className="divide-y rounded-lg border">
      {links.map((l) => {
        const ok = l.status === "Synced" || l.status === "Pushed";
        return (
          <li key={l.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {l.direction === "pull" ? (
                <>
                  Vault <ArrowRight className="size-3.5" /> Secret
                </>
              ) : (
                <>
                  Secret <ArrowRight className="size-3.5" /> Vault
                </>
              )}
            </span>
            <span className="font-mono text-sm font-medium">
              {l.namespace}/{l.secretName}
            </span>
            {l.status === "" ? <Badge variant="outline">Waiting for the operator</Badge> : <Badge variant={ok ? "success" : "destructive"}>{l.status}</Badge>}
            {l.status !== "" && (
              <span className="text-xs text-muted-foreground">
                {ok ? `${l.keyCount} keys · ` : `${l.message} · `}
                {ago(l.reportedAt)}
              </span>
            )}
            {!readOnly &&
              onTakeOver &&
              l.status === "TargetConflict" &&
              l.direction === "pull" &&
              !l.adopt &&
              !l.message.includes("belongs to something else") && (
                <Button className="ml-auto" size="sm" variant="outline" disabled={busy} onClick={() => onTakeOver(l)}>
                  Take over
                </Button>
              )}
            {!readOnly && (
              <Button
                className={l.status === "TargetConflict" && onTakeOver && !l.adopt ? "" : "ml-auto"}
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onUnlink(l)}
              >
                <Unlink /> Unlink
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
