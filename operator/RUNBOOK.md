# Operator runbook

For whoever is on call for the EnvVault operator. Background and settings are in [README.md](README.md).

## First look

```sh
kubectl get evs,evp -A                      # Ready and Reason for every resource
kubectl -n envvault-system get pod          # the operator itself
kubectl -n envvault-system logs deploy/envvault-operator --tail=100
kubectl -n <ns> describe evs <name>         # status, plus the events of the last hour
```

`Reason` tells you what is wrong. Nothing here ever prints a secret value.

**The golden rule: on any error the existing Secret is left as it is.** Running pods keep working. A broken resource is stale, not empty.

## What each reason means

| Reason | Meaning | Do |
|---|---|---|
| `Misconfigured` | Token Secret or key missing, bad spec, push source missing or written by a pull | Read the message; fix the spec or create the Secret |
| `TokenInvalid` | The token Secret does not hold a valid `evt_…` token | Paste the token again, whole, with no quotes or newline added |
| `Unauthorized` | The hub rejected the token: expired or revoked | Create a new service token in the dashboard, update the token Secret. Recovers by itself within one interval |
| `NoAccess` | Project or environment missing, or not shared with this token (the hub does not say which) | Check names; check the token's access in the dashboard |
| `HubUnreachable` | Network, DNS, TLS or hub down (the message says which) | See "Hub unreachable" below |
| `DecryptFailed` | The token's key cannot open the environment | The environment was re-keyed after the token was created, or the token was cut and pasted wrongly. Create a new token with access |
| `InvalidKeys` | An environment key is not a valid Secret key | Rename it on the hub (letters, digits, `-`, `_`, `.`); the message lists them |
| `TargetConflict` | The target Secret exists and is not this resource's | Pick another `target.name`, or delete the other Secret if it is stale. To keep the Secret and let this resource take it over (its contents are replaced by the environment's): `kubectl -n <ns> annotate secret <name> envvault.io/adopt=true`, or press **Take over** on the link in the dashboard. A Secret owned by another link or resource is never taken over |
| `Rejected` | The cluster refused the Secret: over the 1 MiB limit, invalid, or not permitted | Read the message. A Secret holds at most 1 MiB in total: split the environment, or keep big files out of it |
| `RolloutFailed` | Secret written but a `restartOn` workload could not be patched | Check the workload name and kind; check the operator may patch it |
| `ReadOnly` (push) | Token has read access only | Give the token write access to that environment |
| `RekeyPending` (push) | The environment is waiting for a re-key | A person re-keys it in the dashboard, then the push proceeds |
| `HubConflict` (push) | The environment kept changing under three retries | Normally gone by the next interval; if constant, look for another writer |
| `InvalidValues` (push) | The source Secret holds binary data | Push only text values |
| `SourceEmpty` (push) | The source Secret has no keys | Add keys |

A failing resource retries less often (doubling up to 5 minutes) and goes back to normal as soon as it works. Watch `status.consecutiveFailures`.

## Dashboard links

Links made in the dashboard have no custom resource; their status is in the dashboard's Kubernetes tab and in the operator log. The same reasons apply (`TargetConflict`, `NoAccess`, `Unauthorized`, …), plus:

| Reason | Meaning | Do |
|---|---|---|
| `NamespaceNotAllowed` | The link names a namespace outside the list in the ConfigMap `envvault-system/envvault-config` | Add the namespace to its `namespaces` key (`kubectl -n envvault-system edit configmap envvault-config`; picked up within about 30 s, no restart), or unlink |
| *(cluster shows "Token expired")* | The cluster token ran out | Dashboard → Kubernetes → **Replace token**, then run the command it shows. Links, statuses and Secrets are kept |
| `could not reach the hub: tls: failed to verify certificate` in the operator log | The hub has its own certificate the operator does not trust, or it was renewed | Set `hubFingerprint` (and `hubUrl` if needed) in the ConfigMap `envvault-system/envvault-config`; no restart needed |
| *(cluster shows "Not connected")* | No heartbeat for 2 minutes: operator down, cluster token expired or revoked, hub unreachable | Check the operator pod and log; renew the cluster token Secret |

Before a cluster token expires, press **Extend a year** on the cluster in the dashboard (no change in the cluster). The operator's own `tokenExpiresAt` catches up within an hour.

Deleting an environment or project in the dashboard, or revoking the cluster's token, removes the links that depended on it. The Secrets they wrote stay in place as ordinary Secrets. A link to a namespace that does not exist reports `Misconfigured` and starts working once the namespace is created.

Hundreds of links are fine: a 800-link test on a local cluster used about 40 MB and every Secret was written and updated within a minute or two.

Pull links reach the Secret within about a minute and push links within about a second. After an operator restart, links resume from the hub with nothing to re-apply. Unlinking leaves the Secret in place.

## Token expiry

The operator records `status.tokenExpiresAt` and raises a `TokenExpiring` Warning event at 14, 7, 3 and 1 days left. Replace the token Secret's content with a new token before that date; nothing else needs to change.

```sh
kubectl get evs,evp -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,EXPIRES:.status.tokenExpiresAt
```

If a hub is older than this operator it does not report an expiry, and the field stays empty; you will only see `Unauthorized` after the fact.

## Hub unreachable

Existing Secrets and pods are untouched. The resources show `HubUnreachable` and recover within about one interval of the hub returning. Checks, in order:

1. From inside the cluster: `kubectl -n envvault-system run -it --rm t --image=curlimages/curl --restart=Never -- curl -sk <hub url>/` — does it answer?
2. Certificate error in the message: the hub's certificate changed. Update `spec.hub.fingerprint` (printed by the hub at start-up) or the CA Secret.
3. `plain http` refused: the token holds an `http://` address. Use `spec.hub.url` with the https address.
4. A hub that accepts connections but never answers holds a worker for 15 s per call. With `--concurrency` 8, more than 8 such resources would slow the rest; raise `--concurrency`.

## Alerts worth having

With `--metrics-bind-address=:8080` (and a scrape of the operator pod):

- `increase(envvault_reconcile_total{result!="ok"}[15m]) > 0` for a given `result` — something is failing; `Unauthorized` is the one to page on.
- `increase(envvault_reconcile_total{result="ok"}[10m]) == 0` — the operator has stopped checking anything.
- The operator pod not ready, or restarting (`kube_pod_container_status_restarts_total`).
- Warning events with reason `TokenExpiring` (from your event exporter).

## Routine tasks

**Rotate a service token.** Create the new token, update the token Secret's `token` key. The operator notices at the next check (it drops its cached client when the token changes). Then revoke the old token on the hub.

**Upgrade the operator.** Apply the new `config/install.yaml`. The CRDs are updated in place and the operator restarts; Secrets already written are not touched. Do this in one non-production cluster first.

**Roll back.** Re-apply the previous `install.yaml`. Fields added by a newer version are ignored by an older one.

**Pause one resource.** There is no suspend switch. Scale the operator to zero (`kubectl -n envvault-system scale deploy/envvault-operator --replicas=0`): every resource freezes with its current Secret. Scale back up to resume.

**Uninstall safely.** *Deleting an `EnvVaultSecret` deletes the Secret it wrote, and deleting the CRD deletes every resource.* Pods already running keep their environment, but a pod that restarts afterwards cannot start if its Secret is gone. Before removing anything, either remove the workloads' dependence on those Secrets or copy the Secrets (`kubectl get secret … -o yaml`, strip ownerReferences) and apply them as plain Secrets.

## When to suspect the operator itself

- Memory far above ~100 MB, rising file descriptors or goroutines, or restarts: collect `kubectl logs --previous`, the `process_*` and `go_*` metrics, and the number of resources, and report it. Soak runs showed 26–35 MB, 12–15 descriptors and ~102 goroutines for 35 resources with hub outages and pod kills.
- A pushed value that did not reach the hub while the push shows Ready: read the environment from the dashboard first. An earlier soak test client once read empty values for minutes after a hub outage while the hub held the right ones; the cause was never established (the test client could not tell "empty value" from "could not log in"). If you can show it with the operator's `Ready` status and the hub's value side by side, that is a real report.
