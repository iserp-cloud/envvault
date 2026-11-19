# Cloudflare + Postgres deploy

One Worker serves the **static dashboard** and the **oRPC API**. Vault data lives in **Postgres** (SQLite is local-only).

## Why Postgres?

Cloudflare Workers cannot use `better-sqlite3`. Use any Postgres (Neon, Supabase, RDS, …), ideally via [Hyperdrive](https://developers.cloudflare.com/hyperdrive/).

## Local Postgres (Node serve / CLI)

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/envvault
pnpm serve
```

Postgres is selected when `DATABASE_URL` is set in the environment (not via `config.json`).

## Cloudflare deploy

### 1. Build the dashboard

```bash
pnpm install
pnpm build:dashboard
```

### 2. Configure Hyperdrive (recommended)

```bash
wrangler hyperdrive create envvault-db \
  --connection-string="postgres://user:pass@host:5432/envvault"
```

Paste the returned id into `wrangler.jsonc`:

```jsonc
"hyperdrive": [
  { "binding": "HYPERDRIVE", "id": "YOUR_HYPERDRIVE_ID" }
]
```

### 3. Neon connection secret (required with `@neondatabase/serverless`)

The Worker uses the Neon serverless driver (WebSockets), so set your **Neon** URL as a secret (not only Hyperdrive):

```bash
pnpm exec wrangler secret put DATABASE_URL
# paste postgresql://…@….neon.tech/neondb?sslmode=require
```

Hyperdrive remains optional; if both are set, `DATABASE_URL` is preferred for this driver.

Confirm:

```bash
pnpm exec wrangler secret list
```

Quick check after deploy: `GET https://YOUR_WORKER.<subdomain>.workers.dev/health`  
→ `{ "ok": true }` once a database is configured (`503` otherwise). It deliberately does not connect to the database or reveal deployment details; use a real `/rpc` call (e.g. open the dashboard) to confirm connectivity, and `wrangler tail` for the underlying Postgres/Neon error.

Use the URL printed by `wrangler deploy`. It includes the worker name and account subdomain.

### 4. Deploy

```bash
pnpm deploy:cf
# → wrangler deploy (assets from dashboard/dist + Worker API)
```


Local preview:

```bash
pnpm dev:cf
```

Open the Worker URL — UI and `/rpc` are the same origin. **Sign up** to create the first account (it becomes the administrator) (credentials and schema live in Postgres).

Workers CPU limits

Password stretching (PBKDF2, 600k iterations) and all encryption now run **on the client**, so login and signup on the Worker are cheap: one salted HMAC compare, no heavy KDF. The free plan's ~10 ms CPU budget is no longer a constraint on the work factor.

Other details:
- **Request-scoped DB** — each Worker request opens a Neon serverless `Pool`, passes `db` via oRPC context, and closes the pool when done.
- Schema DDL is skipped when `settings.schema_version` is current (one cheap read).
- Set secrets with `wrangler secret put ENVVAULT_PEPPER` and `wrangler secret put ENVVAULT_SETUP_TOKEN`. **Both are required:** without the pepper the Worker answers 503, and without a setup token nobody can create the first account (Workers can't print a generated one). `ENVVAULT_SIGNUP` is a plain var in `wrangler.jsonc`.
- Databases from the old server-side-encryption version are incompatible; use a new, empty database.

## CLI against a Cloudflare hub

```bash
pnpm envvault init --remote https://YOUR_WORKER.workers.dev -d my-app
pnpm envvault login yourname
pnpm envvault push -p my-app -e default -f .env
```

Use the same username/password as the dashboard (derived locally; the hub never sees it).

## Schema

Tables are created automatically on first open, including:

- `users`, `tenants`, `tenant_members`
- `projects`, `environments`, `environment_keys`, `environment_acl`
- Legacy `project_keys` / `project_acl` (migration)
- `settings`
