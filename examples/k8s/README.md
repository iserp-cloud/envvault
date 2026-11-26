# Hub on Kubernetes: example manifests

A starting point, not a product: copy this folder to somewhere git-ignored (for example `deploy/k8s/`), replace the
placeholders, and apply. Nothing here names a real registry, address or password.

| File | What it makes | Edit |
|---|---|---|
| `deployment.yaml` | Namespace `envvault`, the hub Deployment, a ClusterIP Service on port 80, a PodDisruptionBudget | the image; `ENVVAULT_SIGNUP`; drop `imagePullSecrets` for a public image |
| `tls.yaml` | A self-signed certificate (cert-manager) the hub serves itself | the IP addresses or a DNS name |
| `nodeport.yaml` | Optional NodePort `30847` to reach the hub from outside the cluster | the port, or use your Ingress instead |
| `secret.example.yaml` | `DATABASE_URL` and `ENVVAULT_PEPPER` | everything; copy to `secret.yaml` |
| `docker-pull-secret.example.yaml` | Registry credentials, for a private registry only | prefer the `kubectl create secret docker-registry` command in it |

Order: `secret.yaml`, `tls.yaml`, `deployment.yaml`, then `nodeport.yaml` if you want it. Without cert-manager, serve the hub
behind your own TLS (see [docs/deploy.md](../../docs/deploy.md)) and delete the `ENVVAULT_TLS_*` variables, the `tls` volume
and `scheme: HTTPS` in the probes.

The operator has its own examples in [`examples/operator`](../operator).
