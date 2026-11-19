# EnvVault CLI

Sync encrypted environment files with your EnvVault hub. Everything is encrypted on your machine; the hub never sees your password or your secrets.

```bash
npm i -g @iserp/envvault

envvault init --remote https://YOUR_HUB -d my-app
envvault login yourname
envvault pull                       # .env for the project in ./envvault.toml (or your default)
envvault set API_URL=https://x.io
envvault history                    # earlier versions; `history restore 3` brings one back
envvault access grant bob -l write -a delete
```

Drop an `envvault.toml` (or `envvault.json`) next to your code to name its project, environment and files: the CLI finds the nearest one in the current or a parent directory, and from its folder `pull` / `push` sync every target. Run `envvault --help`, or `envvault <command> --help`, for the rest: environments, history, per-person permissions (delete / share / rotate), key rotation.

Full reference: [docs/cli.md](../../docs/cli.md). Config: `~/.config/envvault/config.json` (global session). Requires Node.js 20+. You need a hub account: ask your administrator for an invite, then `envvault signup <username> --invite <code>`.
