# Setup

Requirements: **Node.js 20+**, **pnpm**.

## Install (monorepo / development)

```bash
pnpm install
pnpm build
```

### CLI (from this repo)

```bash
pnpm envvault …          # runs packages/cli via tsx
# or after build:
pnpm --filter @iserp/envvault exec envvault …
```

### Published CLI (end users)

```bash
npm i -g @iserp/envvault
# or: npx @iserp/envvault …
```

Publish from the monorepo (maintainers):

```bash
pnpm publish:cli
```

That publishes **only** `packages/cli` (~21KB bundle + `commander` / `@orpc/client` / `dotenv`). Hub server, Worker, dashboard, and SQLite/Postgres drivers are **not** included.

CLI config is global at `~/.config/envvault/config.json` (session + defaults). Optional per-project overlay: `./.envvault/config.json` via `envvault init --local`.

## First-time hub

```bash
pnpm serve
# open http://127.0.0.1:3847
```

1. Open the dashboard — you land on **Sign in**.
2. Create the first account — it becomes the **administrator**. Then add people from **Administration → Invite someone** (single-use, expiring links). Signup mode is controlled by `ENVVAULT_SIGNUP`.
3. Point the CLI at the hub:

```bash
pnpm envvault init --remote http://127.0.0.1:3847 -d my-app
pnpm envvault login yourname
pnpm envvault push -p my-app -e default -f .env
```

## Database migrations

The hub brings its own schema up to date whenever it starts, so you rarely need to do anything. To do it on purpose, for example before rolling out a new version:

```bash
pnpm migrate --check    # what version is the database at? exits 1 if a migration is pending
pnpm migrate                # apply it
node dist-hub/index.js migrate   # same, from the built hub / container image
```

It uses the same database as `serve` (`DATABASE_URL`, else `ENVVAULT_DB`, else the local SQLite file) and never prints the password. `--check` changes nothing. In Kubernetes, run it as a one-off Job with `args: ["dist-hub/index.js", "migrate"]` and the same `envvault` secret before scaling the deployment up. An old pre-zero-knowledge database is refused with an error, since it needs a new empty one.

## Reaching the hub by IP and port (https without a domain)

Browsers run EnvVault's encryption only on **https** pages (or `localhost`). Over plain `http://<ip>:<port>` the dashboard shows the sign-in form but can't sign you in, and says why. The CLI isn't affected. Pick whichever fits your infrastructure:

- **A reverse proxy or ingress terminates TLS** (nginx, Traefik, Caddy, a load balancer, Tailscale): the usual choice. Nothing to do in EnvVault; use a certificate your browsers and computers already trust. Set `ENVVAULT_TRUSTED_PROXIES` to the number of proxies in front.
- **`localhost` access:** `kubectl port-forward svc/envvault 8080:80` (or an SSH tunnel) and open `http://localhost:8080`; `localhost` counts as secure.
- **The hub serves https itself**, with no proxy, domain or public CA:

  ```bash
  scripts/self-signed-cert.sh 10.0.0.5 10.0.0.6        # every IP or hostname people will type
  ENVVAULT_TLS_CERT=envvault-tls/tls.crt ENVVAULT_TLS_KEY=envvault-tls/tls.key  pnpm serve
  ```

  The script makes one self-signed certificate (in `envvault-tls/`, git-ignored) and prints its fingerprint; the hub logs the same at startup. Browsers: trust `tls.crt` once per computer (import it into the OS or browser certificate store), or click through the warning. On an orchestrator, mount the pair from a secret and probe over https (a health probe doesn't need to trust the certificate). For the CLI: nothing to do, `envvault remote set https://<ip>:<port>` remembers the certificate (see `docs/cli.md`). Keep `tls.key` private.

## Client machine (CLI → remote hub)

```bash
npm i -g @iserp/envvault
envvault init --remote https://YOUR_WORKER.workers.dev -d my-app
envvault login yourname
envvault use personal
envvault pull -p my-app -e default -f .env
```

## Environment overrides

| Variable | Meaning |
|---|---|
| `ENVVAULT_REMOTE` | Hub URL override |
| `ENVVAULT_PASSWORD` | Non-interactive CLI login / signup / recover password |
| `ENVVAULT_TOKEN` | CI: a service token (`evt_…`); acts as a session, hub URL included |
| `ENVVAULT_KEYCHAIN` | `off` to skip the OS keychain (CLI falls back to password-sealed storage) |
| `ENVVAULT_RECOVERY_KEY` | Non-interactive `envvault recover` |
| `ENVVAULT_AUDIT_RETENTION_DAYS` | How long the hub keeps audit events (default 365) |
| `DATABASE_URL` | Postgres URL for local `pnpm serve` / Worker |
| `ENVVAULT_SIGNUP` | `invite` (default) \| `open` \| `closed` — who may sign up after the first account |
| `ENVVAULT_PEPPER` | Secret mixed into stored login-proof hashes (keep outside the DB; changing it invalidates logins) |
| `ENVVAULT_ALLOW_NO_PEPPER` | `true` to start in production without a pepper (not recommended) |
| `ENVVAULT_SETUP_TOKEN` | Pin the first-run token (otherwise one is generated and printed in the server log) |
| `ENVVAULT_TRUSTED_PROXIES` | Reverse-proxy hops whose `X-Forwarded-For` to trust (default 0 = ignore the header) |
| `ENVVAULT_HSTS` | `true` to send Strict-Transport-Security (when TLS terminates in front of the hub) |
| `ENVVAULT_SESSION_DAYS` | Session lifetime (default 14) |
| `ENVVAULT_CORS_ORIGINS` | Extra CORS origins (comma-separated) |
| `PORT` | Server port when serving (default `3847`) |

**Local Postgres with Docker:**

```bash
# For a new local Postgres volume, run once from the project root.
pg_password=$(openssl rand -hex 32)
(umask 077; printf 'POSTGRES_PASSWORD=%s\nDATABASE_URL=postgresql://envvault:%s@127.0.0.1:5433/envvault\n' "$pg_password" "$pg_password" >> .env)
unset pg_password
docker compose up -d
pnpm serve               # creates the schema on first start
```

The Node server connects with the standard `pg` driver, so any Postgres works. The Neon serverless driver is used only by the Cloudflare Worker.

Postgres is configured **only via** `DATABASE_URL`. Put it in a `.env` file in the project root (loaded automatically) or export it in your shell.

For a single Cloudflare Worker (static UI + API) see [cloudflare.md](cloudflare.md).

## Local dashboard development

```bash
# terminal 1 — oRPC + vault + static UI
pnpm serve

# terminal 2 — Vite (optional)
pnpm dev:dashboard
```
