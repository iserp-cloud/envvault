# Usage

## Dashboard

1. Open the hub URL (local `http://localhost:3847` or your Worker).
2. **Sign up** / **Sign in**.
3. Work in **Personal** or an **organization** tenant.
4. Create projects and environments; open the environment's access pane (the gear icon) to choose each member's level and extra permissions: **Delete**, **Share**, **Rotate keys**. *Manager* grants all three.
5. **Version history** (clock icon on an environment): every save keeps the previous version (newest 50 per environment). Open one to see what restoring it would add, remove or change, then **Restore** to load it into the editor as a draft — review and save, which records a new version (the old one stays). Users with the Delete permission can delete individual versions. Anyone who can read an environment can read its history.

## CLI (hub-aware)

Same auth model as the dashboard.

```bash
pnpm envvault init --remote https://YOUR_HUB -d my-app
pnpm envvault login yourname
pnpm envvault use personal          # or org slug
pnpm envvault project create my-app      # if it does not exist yet
pnpm envvault push -p my-app -e default -f .env
pnpm envvault pull -p my-app -e default -f .env
pnpm envvault set API_KEY=… -p my-app
pnpm envvault get API_KEY -p my-app
pnpm envvault list
pnpm envvault list --envs -p my-app
```

See [cli.md](cli.md) for the full command reference.

## Local hub

```bash
pnpm serve
# open http://localhost:3847
```

Point the CLI at it with `--remote http://127.0.0.1:3847`.

## Theme

The dashboard supports light and dark mode. Use the sun/moon/monitor button in the header (or top-right on the sign-in screen) to cycle System → Light → Dark; the choice is remembered per browser.
