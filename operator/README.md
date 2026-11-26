# EnvVault operator

On call? See [RUNBOOK.md](RUNBOOK.md).

Keeps a Kubernetes `Secret` in step with one EnvVault environment, and optionally rolls the workloads that use it.

```
EnvVault hub  ──(service token, read-only)──▶  operator  ──▶  Secret  ──▶  your pods
 ciphertext only                              decrypts in the cluster
```

The hub still never sees plaintext. The operator decrypts inside your cluster with the service token's private key, then writes an ordinary Secret. That means the values sit in etcd like any other Secret: turn on etcd encryption and restrict who can read Secrets.

## Install

1. Build and push the image (the manifest points at `ghcr.io/iserp-cloud/envvault-operator:0.1.0`; use your own registry):

   ```sh
   make docker IMG=registry.example.com/envvault-operator:0.1.0
   docker push registry.example.com/envvault-operator:0.1.0
   make manifests IMG=registry.example.com/envvault-operator:0.1.0 OUT=../deploy/operator/install.yaml
   ```

   `OUT` keeps your own file (with your registry) out of the committed `config/install.yaml`, which stays the generic example. `deploy/` is git-ignored. A private registry also needs a pull secret on the operator's ServiceAccount: see [`../examples/operator/docker-pull-secret.example.yaml`](../examples/operator/docker-pull-secret.example.yaml).

2. Apply it (CRD, RBAC and the operator in the `envvault-system` namespace):

   ```sh
   kubectl apply -f ../deploy/operator/install.yaml   # or config/install.yaml, the generic example
   ```

## Use

Create a **service token** in the dashboard (workspace → Service tokens). Give it **read** access to exactly the environment this namespace needs. Then:

```sh
kubectl -n prod create secret generic envvault-token --from-literal=token='evt_…'
```

```yaml
apiVersion: envvault.io/v1alpha1
kind: EnvVaultSecret
metadata:
  name: my-app
  namespace: prod
spec:
  tokenSecretRef: { name: envvault-token }
  project: my-app
  environment: production
  target: { name: my-app-env }        # the Secret to write (defaults to this resource's name)
  refreshInterval: 60s                # default 60s, minimum 10s
  restartOn:                          # optional: roll these when the values change
    - { kind: Deployment, name: my-app }
```

Use it like any Secret:

```yaml
envFrom:
  - secretRef: { name: my-app-env }
```

```sh
kubectl -n prod get envvaultsecrets     # short name: evs
```

### Reaching a hub with its own certificate

The token carries the hub address. For a self-signed hub, trust it with either of these under `spec.hub`:

```yaml
hub:
  fingerprint: "D0:8B:AA:…"            # SHA-256, printed by the hub at start-up
  # or
  caSecretRef: { name: envvault-ca }   # Secret holding the PEM under `ca.crt`
```

`url` overrides the address in the token. `insecureSkipVerify` exists for testing only. A plain `http://` hub is refused unless `allowPlainHTTP: true`, because the token would travel in the clear.

### Pushing a Secret to the hub

The other direction: `EnvVaultPush` writes the keys of a Kubernetes Secret into an environment. Use a token with **write** access to that environment.

```yaml
apiVersion: envvault.io/v1alpha1
kind: EnvVaultPush
metadata:
  name: my-app-push
  namespace: prod
spec:
  tokenSecretRef: { name: envvault-write-token }
  project: my-app
  environment: production        # must already exist; a token cannot create one
  sourceSecretName: my-app-config
  refreshInterval: 60s
```

```sh
kubectl -n prod get envvaultpushes     # short name: evp
```

- **Immediate.** The operator labels the source Secret `app.kubernetes.io/managed-by=envvault-push-source` (its data is not touched) and watches it, so an edit is pushed within about a second. The interval is only a safety net that also catches edits made on the hub. If the label can't be set, it falls back to checking every interval.
- **The Secret wins for the keys it has.** Those keys are set on the hub, and a different value edited there is put back on the next check. Keys the Secret doesn't have are left alone, and **nothing is ever deleted on the hub**.
- **Never overwrites someone else's save.** The write is refused by the hub if the environment changed in between. The operator then reads the new version, merges again and retries at once (three tries); only if that keeps failing does it show `HubConflict` and wait for the next interval.
- **Edited on both sides at the same time.** Different keys: both edits survive (the push merges into whatever the hub holds). The same key: the Secret's value wins and the hub's edit stays in the version history. A person saving in the dashboard just after a push gets the dashboard's normal "changed meanwhile" prompt and reloads.
- **One push link per environment.** Two Secrets pushing into one environment would overwrite each other's keys whenever a key is in both, taking turns on every check, so the hub refuses a second push link (`CONFLICT`, with the Secret that already pushes). Pull links are unlimited, and an environment can have one push link and any number of pull links. Unlink the push link to use another Secret. The database enforces it, so two simultaneous requests can't both succeed. A hub that already holds two push links into one environment still starts and logs a `WARNING` naming them; remove the extras and the guarantee switches on at the next start. This applies to links made in the dashboard; `EnvVaultPush` resources are not limited by it, so don't point two of them (or one and a link) at the same environment.
- **Every push is a saved version** in the environment's history, labelled `Pushed by envvault-operator (namespace/name)`, and shows as `env.save` in the audit log.
- Values must be text (binary data is refused: `InvalidValues`). A read-only token gives `ReadOnly`; an environment waiting to be re-keyed gives `RekeyPending`.
- A Secret that an `EnvVaultSecret` writes can't be used as a push source (`Misconfigured`), so a pull and a push can't loop on each other.
- If a pull and a push use different Secrets for the same environment, the pushed Secret's values win for the keys it has.

### Linking from the dashboard

Instead of writing a resource per Secret, install the operator once with a **cluster token** and link environments to Secrets from the dashboard's **Kubernetes** tab (the Boxes button on an environment; needs the "share" capability on it).

1. In the dashboard, create a cluster token (it is a service token named `k8s-<name>`, with no access yet) and store it in the cluster:
   ```sh
   kubectl -n envvault-system create secret generic envvault-cluster-token --from-literal=token=evt_…
   ```
2. Apply `install.yaml`. The operator starts reading the token Secret as soon as it exists, so the order of steps 1 and 2 doesn't matter. Links may use any namespace unless you limit them with the ConfigMap below. It then shows as **Operator connected** with its version and the namespaces it may write to.
3. On an environment, pick a direction, a namespace, a name and a **key group**, choose Secret or ConfigMap, and press **Link**.
   - **Vault → Secret** creates the Secret and keeps it in step with the environment (a hub edit arrives within about a minute).
   - **Secret → Vault** pushes the keys of an existing Secret into the environment (a Secret edit arrives within about a second).

| Flag | |
|---|---|
| `--cluster-token-secret=<ns>/<name>` | The Secret holding the cluster token (key `token`). Defaults to `envvault-system/envvault-cluster-token`. Links start working once it exists, with no restart. |
| `--link-config=<ns>/<name>` | Optional ConfigMap that limits where links may write (default `envvault-system/envvault-config`, see below). Read on every poll, so editing it needs no restart. |
| `--hub-url`, `--hub-fingerprint`, `--hub-ca-file`, `--hub-allow-plain-http` | The same trust settings as `spec.hub`. For dashboard links the first two are better set in the ConfigMap below, which is read live and wins over them. |
| `--link-interval` | How often the operator asks the hub for links (default `30s`). |

**Settings you can change without redeploying: the `envvault-config` ConfigMap.** It is optional, lives in the operator's namespace and is read again on every poll (about 30 s). Edit it and the operator follows; nothing is reinstalled or restarted.

A commented, ready-to-edit copy is in [`../examples/operator/envvault-config.yaml`](../examples/operator/envvault-config.yaml) (keep it out of `install.yaml`, which would overwrite your values each time it is applied). Or create it directly:

```sh
kubectl -n envvault-system create configmap envvault-config \
  --from-literal=namespaces='prod,app-a' \
  --from-literal=hubUrl='https://envvault.envvault.svc:80' \
  --from-literal=hubFingerprint='AB:CD:…'
```

| Key | Meaning |
|---|---|
| `namespaces` | Where links may write: a comma or space separated list, or `*`. No ConfigMap or no key means every namespace; a key with an empty value means none. The list is reported to the hub, which refuses new links to other namespaces; a link already outside it reports `NamespaceNotAllowed` and stops being updated (its Secret stays). |
| `hubUrl` | The hub's address, when the one in the cluster token is not reachable from the cluster (for example the in-cluster Service). Wins over `--hub-url`. |
| `hubFingerprint` | SHA-256 of the hub's certificate, for a hub with its own certificate. Update it here when the certificate is renewed. Wins over `--hub-fingerprint`. |

If the ConfigMap cannot be read, the last values are kept; deleting it goes back to the flags and the cluster token's address. A plain `http://` address is still refused unless the operator runs with `--hub-allow-plain-http`, so the ConfigMap cannot downgrade the connection. Whoever can edit this ConfigMap can point the operator (and its token) at another hub, so give that right only to people who could already edit the operator's Deployment.

### Key groups: one environment, several Secrets and ConfigMaps

An app often needs a Secret and a ConfigMap, or two Secrets. Give each key a **group** in the editor (the Group column; empty means `default`) and link each group where it should go:

| Key | Group |
|---|---|
| `DATABASE_URL`, `DB_PASSWORD` | `db` |
| `STRIPE_KEY` | `payments` |
| `LOG_LEVEL`, `FEATURE_X` | (default) |

Link `default` as the ConfigMap `app-config` and `db` as the Secret `app-db`, and each holds only its own keys. Groups are part of the encrypted data, so the hub never sees how your keys are organised.

**The Groups button** on an environment opens its list of group names. Add a name once (`db`) and it becomes a choice in every key's Group menu and in the link form, so nobody retypes it. A name can be registered before any key uses it, and a name that keys use cannot be removed until they move. The list is stored inside the encrypted environment too, and the operator leaves it untouched when it pushes.

**Importing and filtering.** Paste a `.env` with `# @group name` lines, or JSON with an object per group, into Import and the keys land in those groups (names join the list); export writes them back the same way. Above the key list, group buttons show only one group's keys.

**Nothing about groups reaches the cluster.** A Secret or ConfigMap holds the link's keys and values and the operator's own ownership labels and annotations. Group names, the list of names and the `# @group` lines are never written to it, and a test checks this.

- **Every existing environment and link is in the `default` group**, so nothing changes until you use groups. A group name is 1 to 40 lowercase letters, digits or dashes, and cannot be `default`.
- **A link carries one group and one kind** (`Secret` or `ConfigMap`). A Secret and a ConfigMap may share a name; two links to the same kind and name may not. `spec.group` and `spec.target.kind` do the same for an `EnvVaultSecret` or `EnvVaultPush`.
- **An empty group writes nothing.** A link to a named group with no keys reports `GroupEmpty` and leaves the target alone. The `default` group may be empty.
- **Moving a key between groups** moves it between the targets on the next sync.
- **Push** (Secret → Vault) puts the pushed keys in the link's group and leaves every other key and group alone. Only a Secret can push.
- **A ConfigMap is not protected like a Secret.** Anyone who can read ConfigMaps in the namespace can read it, and it is not encrypted at rest by default. The dashboard warns when a key that looks sensitive goes into one. Binary data added to a managed ConfigMap is removed on the next sync, like any other edit.
- **Old readers refuse a grouped environment** instead of writing it wrongly: upgrade the hub, the operator and the CLI before using groups. An environment with no groups is stored exactly as before, so old clients keep working with it.
- **Permissions.** The operator now also needs to create and update ConfigMaps (`install.yaml` is updated; `kubectl apply` it again). Drop `configmaps` from its ClusterRole if you never write a ConfigMap, and give the operator `get` on the settings ConfigMap instead.

- **The hub keeps only the mapping** (cluster, namespace, name, kind, group, direction, status). Values never leave the browser unencrypted: linking grants the cluster token read (pull) or write (push) access to that one environment, with the key wrapped for it by the person linking.
- **One writer per target.** A Secret (or a ConfigMap) can be linked once; the operator will not overwrite a Secret it did not create (`TargetConflict`) unless it was invited to (see "Never overwrites by default" below), and will not push a Secret that a link or an `EnvVaultSecret` writes.
- **Both directions on one environment** is fine, with different Secrets (for example a pull into `app-env` that your pods read, and a push from `app-generated`). The cluster token holds `write` while any link on that environment pushes, and drops back to `read` when the last push link is removed. If a pushed key also exists in the vault, the Secret's value wins for that key.
- **Unlink** stops updates and removes the operator's labels; the Secret and its values stay. When it is the cluster's last link on that environment, the cluster token's access to it is revoked.
- Status (`Synced`, `Pushed`, `TargetConflict`, …) and key counts are reported back and shown in the dashboard. Namespaces outside the allow-list report `NamespaceNotAllowed`.
- **Token expiry.** The cluster token lasts a year. The dashboard shows its expiry from 30 days ahead, with an **Extend a year** button on the cluster: the same token gets more time, so nothing changes in the cluster. Do this before it expires.
- **If it expired anyway** the operator stops syncing and the cluster shows "Token expired", but Secrets already in the cluster are untouched. Press **Replace token** (needs owner or admin, and "share" on every linked environment): a new token is made with the same access, the links move to it, and the old one is retired. Put the new token into the cluster with the command shown (it replaces the Secret's content; the operator picks it up within a minute, with no restart). An expired token cannot be extended because its key can no longer be recovered, which is why a new one is needed.
- Needs a hub that has the Kubernetes routes (this release or later).

## Behaviour

- **Only changes are downloaded.** Every interval the operator asks the hub for the environment's version; it downloads and decrypts only when that changed. Each download shows as an `env.read` in the hub's audit log.
- **Not instant.** The hub has no push channel, so a change appears within one `refreshInterval`.
- **Self-healing.** If the Secret is edited or deleted, it is put back (within about one interval).
- **Backs off when something is wrong.** After repeated failures a resource is retried less often (doubling up to 5 minutes), and its status shows `consecutiveFailures`. It goes back to the normal interval as soon as it works again.
- **Never overwrites by default.** If the target Secret exists and wasn't created by this resource, the operator refuses (`TargetConflict`) and the message gives the fix. To let it take over a Secret that is already there, either annotate that Secret (the cluster owner's say): `kubectl -n <ns> annotate secret <name> envvault.io/adopt=true`, or tick "Take over this Secret if it already exists" on the link in the dashboard (the **Take over** button on a conflicted link does the same later). The Secret's contents are then replaced by the environment's values and the annotation is removed. A Secret that another link, an `EnvVaultSecret` or a push source owns is never taken over, whatever either side says. This is also how to re-link a name after unlinking it: unlinking leaves the Secret in place as an ordinary Secret.
- **Fails closed.** On any error (expired token, wrong certificate, hub down, decryption failure) the existing Secret is left as it is and the reason is shown on the resource (`kubectl describe`). Values never appear in status, events or logs.
- **Rollouts.** `restartOn` stamps the hub version into the workload's pod template, so Kubernetes replaces the pods only when the values change.
- **Token expiry.** The status shows `tokenExpiresAt` (when the hub reports it) and a `TokenExpiring` Warning event is raised at 14, 7, 3 and 1 days left. Needs a hub that returns the expiry from `me`.
- **Events.** `kubectl describe` shows a Warning when a resource starts failing or fails for a new reason (once, not on every retry), and a Normal event when it updates or recovers. They carry the same text as the status, never values.
- **Deleting the resource deletes the Secret** (it is owned by it).
- Keys must be valid Secret keys (letters, digits, `-`, `_`, `.`); otherwise nothing is written and the offending names are listed.

Ready reasons: `Synced`, `Misconfigured`, `TokenInvalid`, `Unauthorized` (expired or revoked), `NoAccess` (missing or not shared; the hub doesn't say which), `HubUnreachable`, `DecryptFailed`, `InvalidKeys`, `GroupEmpty`, `TargetConflict`, `Rejected` (the cluster refused the Secret, e.g. over its 1 MiB limit), `RolloutFailed`.

## Flags

| Flag | Default | |
|---|---|---|
| `--concurrency` | `8` | Resources reconciled at once. A hub that hangs holds a worker for up to 15 s per call, so keep this above the number of resources that might point at a dead hub. |
| `--kube-api-qps` / `--kube-api-burst` | `50` / `100` | Request budget towards the Kubernetes API. Each healthy resource costs about one read per interval. |
| `--namespace` | all | Only watch one namespace. |
| `--leader-elect` | `false` | Needed with more than one replica. |
| `--metrics-bind-address` | `0` (off) | e.g. `:8080`. Besides the standard controller-runtime metrics: `envvault_reconcile_total{controller,result}` (`ok` or the failure reason) and `envvault_updates_total{controller}`. Alert on a rising failure rate for a reason such as `Unauthorized`. |

## Measured

On a single-node `kind` cluster (arm64), with the real hub image and Postgres:

| | |
|---|---|
| 200 resources, 10 s interval | all ready in 16 s; a hub change reached all 200 Secrets in 22 s |
| 1000 resources, 10 s interval | all ready in 22 s; a change reached all 1000 in 32 s; operator about 32 MB and 6% of a core |
| Hub down | Secrets and running pods untouched; every resource reports `HubUnreachable`; recovery within a poll interval of the hub returning |
| Hub that hangs (never answers) | 20 such resources did not delay the other 200 beyond 22 s (8 workers, backoff, 15 s timeout). With a single worker the same test updated only 13 of 200 in two minutes, which is why the default is 8 |
| Token revoked | `Unauthorized`, Secret kept; a new token in the token Secret recovers it with no other change |
| Soak: 30 pulls + 5 pushes, 10 s interval, edits every ~40 s, hub down for 25 s every 5 min, operator pod killed | five runs of 6 to 30 minutes: operator steady at 26–35 MB, 12–15 open file descriptors, about 102 goroutines, no restarts, never not-ready; every Secret and every pushed value was correct at the end. Two early runs had a 5-minute window where my test client read an empty value for the pushed keys; it did not recur in the three later runs and the cause was not found |
| Leader killed (2 replicas) | a new leader took over in about 16 s; no Secret lost |

These are one machine and a short run, not a soak. Your numbers depend on how far the hub is from the cluster.

## Permissions and scope

The default install is cluster-wide and its ClusterRole can read and write Secrets and ConfigMaps and patch Deployments, StatefulSets and DaemonSets. To narrow it:

- drop the `apps` rule if you don't use `restartOn`;
- run with `--namespace prod` and replace the ClusterRole/Binding with a Role/RoleBinding in that namespace.

Only Secrets and ConfigMaps the operator wrote (label `app.kubernetes.io/managed-by=envvault-operator`) are held in its cache; token and CA Secrets are read on demand.

## Develop

```sh
make test                      # unit tests, including the shared protocol vectors
go test ./internal/vault -run '^$' -fuzz FuzzOpenEnv -fuzztime 30s   # fuzz the untrusted-input parsers (see fuzz_test.go)
make manifests                 # regenerate deepcopy code, CRD and config/install.yaml
make vectors                   # refresh testdata/zk-6.json from the TypeScript side
```

The decrypt path follows [`docs/protocol.md`](../docs/protocol.md). `testdata/zk-6.json` is generated by the TypeScript code (`pnpm vectors`) and both test suites must pass it.

An end-to-end test runs the controller against a real API server (envtest) and a real hub:

```sh
# at the repo root: start a throwaway hub and seed it (writes a token into $E2E_DIR)
ENVVAULT_TLS_CERT=… ENVVAULT_TLS_KEY=… E2E_DIR=/tmp/e2e DATABASE_URL= pnpm tsx scripts/e2e-seed.ts
# then
E2E_DIR=/tmp/e2e KUBEBUILDER_ASSETS=$(setup-envtest use -p path) go test -tags e2e ./internal/controller -run E2E
```
