# Operator examples

Copy what you need out of this folder and edit the copy; the files here hold placeholders only.

| File | What it is |
| --- | --- |
| `envvault-config.yaml` | The live `envvault-system/envvault-config` ConfigMap (namespaces, hub URL, hub fingerprint). |
| `docker-pull-secret.example.yaml` | How to create an image pull secret for a private registry (comments only, no credentials). |

The install manifest itself is [`operator/config/install.yaml`](../../operator/config/install.yaml). Generate your own with
`make manifests IMG=<your image> OUT=../deploy/operator/install.yaml` (run in `operator/`); `deploy/` is git-ignored.
The hub's examples are in [`examples/k8s`](../k8s).
