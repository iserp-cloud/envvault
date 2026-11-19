# Dashboard

Vite + React 19 UI for EnvVault (Tailwind CSS 4, shadcn-style components).

## Develop

```bash
# from repo root — API must be running
pnpm serve

# from repo root or dashboard/
pnpm --filter dashboard dev
# http://localhost:5173 — proxies /rpc → http://127.0.0.1:3847
```

## Build

```bash
pnpm --filter dashboard build
# output: dashboard/dist (served by envvault serve)
```

## Layout

| Path | Role |
|---|---|
| `src/App.tsx` | Session gate |
| `src/UnlockScreen.tsx` | Sign in / sign up |
| `src/VaultApp.tsx` | Projects, environments, settings |
| `src/api.ts` | oRPC client + crypto helpers |
| `src/components/` | Tenant settings, project visibility, UI primitives |

See [../docs/usage.md](../docs/usage.md) and [../docs/architecture.md](../docs/architecture.md).
