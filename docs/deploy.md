# Deploying with Docker

The hub ships as a small distroless container (Node 22, non-root, ~220 MB) that serves the API and the dashboard. It targets **Postgres**; use a **new, empty database** (old server-side-encryption databases are refused).

## Docker / Compose

For a new database, generate the local Postgres settings using the instructions in [setup.md](setup.md). For an existing volume, set `POSTGRES_PASSWORD` to its existing role password. To run the hub alongside Postgres, uncomment the hub service in `docker-compose.yml` and set `ENVVAULT_PEPPER` in `.env`.

```bash
docker compose --profile app up -d --build     # Postgres + the hub
docker compose logs hub                         # prints a one-time setup token
# open http://127.0.0.1:3847 → create the first (administrator) account with that token
```

The image runs as uid 65532 with a read-only root filesystem, no capabilities and `no-new-privileges` (see `docker-compose.yml`). Build it yourself with `docker build -t envvault-hub .`.

### Upgrading the database

The hub brings its own schema up to date when it starts. To do it on purpose (for example before a rollout), run the same image with the `migrate` command, using the same `DATABASE_URL`:

```bash
docker run --rm -e DATABASE_URL=… envvault-hub dist-hub/index.js migrate --check   # exits 1 if a migration is pending
docker run --rm -e DATABASE_URL=… envvault-hub dist-hub/index.js migrate
```

## Kubernetes, Nomad, ECS and other orchestrators

No manifests ship with the project: they depend on your cluster, registry, ingress and policies. Anything that can run a container runs the hub. Build the image with the `Dockerfile` (or pull it from your registry) and give it:

- **Port** `3847` (set `--host 0.0.0.0`, which the image already does) and a **new, empty Postgres database** in `DATABASE_URL`.
- **Secrets** `DATABASE_URL` and `ENVVAULT_PEPPER` from your secret store, never baked into the image (see Configuration below).
- **Probes:** liveness `GET /healthz`, readiness `GET /readyz` (see Probes). If the hub itself serves https, probe with the https scheme.
- **Hardening it already supports:** non-root (uid 65532), read-only root filesystem, no added capabilities.
- **A way in:** an ingress or load balancer that terminates TLS (set `ENVVAULT_TRUSTED_PROXIES` to the number of proxies in front), or a plain NodePort with the hub's own https. Browsers need https for the dashboard; see `docs/setup.md`, "Reaching the hub by IP and port".

A `DATABASE_URL` that looks like a URL but doesn't start with `postgres://` or `postgresql://` (a typo such as `postgressql://`) is refused at startup. It is never treated as a file path, which would put the connection string, password included, into a file name.

## Configuration

| Variable | Recommended | Why |
|---|---|---|
| `DATABASE_URL` | `…?sslmode=verify-full` | Required. Without TLS to a remote DB, credentials and ciphertext cross the network in the clear — the hub warns at startup. |
| `ENVVAULT_PEPPER` | long random secret | **Required in production** — the hub refuses to start without it (`ENVVAULT_ALLOW_NO_PEPPER=true` overrides, not recommended). Mixed into stored login-proof hashes and audit signatures; without it they use a public constant. Keep it out of the database; changing it invalidates all logins, so back it up. |
| `ENVVAULT_TRUSTED_PROXIES` | `1` behind one ingress | How many reverse-proxy hops' `X-Forwarded-For` to trust. **Default 0 ignores the header**, so clients can't forge their address and dodge rate limits. Set it to your real hop count (ingress = 1; load balancer + ingress = 2). |
| `ENVVAULT_HSTS` | `true` | Sends `Strict-Transport-Security`. Enable once TLS terminates in front of the hub. |
| `ENVVAULT_TLS_CERT` / `ENVVAULT_TLS_KEY` | unset | Paths to PEM files. When both are set the hub serves https itself, for deployments with no proxy in front (see `docs/setup.md`). Set both or neither. |
| `ENVVAULT_SIGNUP` | `invite` | `invite` (default), `open`, or `closed`. |
| `ENVVAULT_SESSION_DAYS` | `14` | Session lifetime. |
| `ENVVAULT_SETUP_TOKEN` | optional on Node | Pin the first-run token instead of generating one. **Required on Cloudflare Workers**, which can't print one. |
| `ENVVAULT_AUDIT_RETENTION_DAYS` | `365` | Audit retention. |

### First run

Until the first account exists, signup requires a **setup token** — and the server **fails closed**: with no token configured, nobody can create the first account. so a stranger who reaches a fresh deploy can't claim the admin account. The hub generates one, stores it in the database (so every replica agrees) and prints it to the log. It is deleted as soon as the admin account is created.

If you ever wipe the `users` table by hand to start over, also run `DELETE FROM settings WHERE key IN ('admin_claimed','setup_token');` — otherwise the hub correctly believes it was already set up.

### Probes

`GET /healthz` (liveness, no DB) and `GET /readyz` (readiness, checks the database) return `{"ok":true}`.

### Rate limiting

Login, signup, recovery and password-change attempts are counted **in the database**, so limits hold across replicas and restarts. Failed sign-ins are also throttled **per account across all addresses**, so spreading guesses over many IPs doesn't help. Once an account is throttled, strangers are blocked but an address that has signed in to it before still gets through (the password and per-address limits still apply), so an attacker can't lock the real owner out of their usual connection.

### Backups & secrets

- The database holds only ciphertext, public keys and hashes — safe to back up, but unrecoverable without users' passwords or recovery keys.
- Store `ENVVAULT_PEPPER` and `DATABASE_URL` in your secret manager (a Kubernetes Secret, External Secrets, Vault …), never in the image.
- Pin the image by digest in production, and scan it before deploying (for example `trivy image envvault-hub`). Run `pnpm audit --prod` and `pnpm test` before each release.
