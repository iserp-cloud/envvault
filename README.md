# EnvVault

Zero-knowledge env vault for teams: a hub, a web dashboard, and a CLI. Secrets are encrypted on your device — the server only stores ciphertext.

Encryption happens in the **browser and CLI** (AES-256-GCM, RSA-OAEP keypairs, Argon2id → HKDF key derivation). The server never receives your password or any decryption key. Storage is **Kysely** on SQLite or Postgres; the API is **oRPC** (`/rpc`). See [Security](docs/security.md) for exactly what the server can and cannot see.

## Docs

| Guide | |
|---|---|
| [Setup](docs/setup.md) | Install, serve, signup, config |
| [Usage](docs/usage.md) | Dashboard (personal/orgs, projects, environments) |
| [CLI](docs/cli.md) | Command reference |
| [Security](docs/security.md) | Threat model, key hierarchy, limitations |
| [Deploy](docs/deploy.md) | Docker, Compose, running it on an orchestrator, hardening settings |
| [Architecture](docs/architecture.md) | Tenants, environments, crypto, RPC |
| [Cloudflare](docs/cloudflare.md) | Worker + Postgres deploy |
| [Kubernetes operator](operator/README.md) | Sync environments to Kubernetes Secrets (and back), from the dashboard or with resources |

## Quick start

```bash
pnpm install
# For a new local Postgres volume, run once from the project root.
pg_password=$(openssl rand -hex 32)
(umask 077; printf 'POSTGRES_PASSWORD=%s\nDATABASE_URL=postgresql://envvault:%s@127.0.0.1:5433/envvault\n' "$pg_password" "$pg_password" >> .env)
unset pg_password
docker compose up -d
pnpm build
pnpm serve
# open http://127.0.0.1:3847 — the first account becomes the administrator
```

Add people from **Administration → Invite someone** (single-use links), or let anyone sign up with `ENVVAULT_SIGNUP=open`.

CLI from this repo (`pnpm envvault …`) or from npm after publish:

```bash
npm i -g @iserp/envvault
envvault init --remote http://127.0.0.1:3847 -d my-app
envvault signup yourname --invite <code>   # or: envvault login yourname
envvault push -p my-app -e default -f .env
```

Run the tests with `pnpm test`. Publish the CLI only: `pnpm publish:cli`. Run it in containers: see [Deploy](docs/deploy.md).

## Concepts (short)

- **Personal vault** — created on signup; private to you.
- **Organization** — shared tenant; invite by username; unique slug.
- **Project** — container under a vault.
- **Environment** — `default`, `staging`, `production`, … each with its own secrets and visibility ACL.

## Security notes

- Never commit plaintext `.env` files. The CLI keeps your private key encrypted (unlock key in the OS keychain), not in plaintext.
- **Forgot your password?** Use your **recovery key** (shown once at signup). Lose both and that account's data is unrecoverable by design; a workspace admin can re-grant access to a new account.
- Serve over HTTPS (or a VPN / SSH tunnel) beyond a trusted LAN, and set `ENVVAULT_PEPPER` and (on a fresh public deploy) `ENVVAULT_SETUP_TOKEN`.
- Revoking someone **rotates** the environment key, but values they already saw must be rotated too.
- CI/CD: use scoped, expiring **service tokens** instead of a human login. Activity is recorded in an **audit log** (never values).
- Read the [remaining limitations](docs/security.md#remaining-limitations) — notably a malicious server can serve malicious JavaScript, metadata is visible, and the code is unaudited.
