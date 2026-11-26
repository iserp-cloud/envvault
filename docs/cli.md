# CLI reference

Install from npm (`npm i -g @iserp/envvault`) or run from this repo with `pnpm envvault …`.

The CLI is a **thin client**: username/password login, tenants, projects, environments. It does **not** include the hub server.

**Config**

| File | Purpose |
|---|---|
| `~/.config/envvault/config.json` | Global: remote, defaults, **session** (secrets) |
| `./.envvault/config.json` | Optional project overlay: remote / default project / env only |

Session always lives in the global file so one `login` works across repos. Override with `ENVVAULT_CONFIG_DIR` if needed.


## Quick start (against a hub)

```bash
envvault init --remote https://envvault.example.com -d my-app
envvault login yourname          # prompts for the password (masked)
envvault project create my-app   # a project with a `default` environment
envvault push                    # .env → hub
envvault pull                    # hub → .env
```

You need an account on the hub: sign up in the dashboard, or with `envvault signup` and an invite code.

## Choosing the hub

The CLI has no built-in server: it talks to whichever hub you point it at, your own deployment or `http://localhost:8787` while developing. From strongest to weakest:

| How | Scope |
|---|---|
| `--remote <url>` on any command | that command only |
| `ENVVAULT_REMOTE=<url>` | the shell / CI job |
| `remote = "<url>"` in `envvault.toml` / `envvault.json` | that directory tree |
| `envvault remote set <url> --local` (`./.envvault`) | this directory |
| `envvault remote set <url>` | everywhere (default) |

```bash
envvault remote                  # which hub, and what set it
envvault remote set https://envvault.example.com
envvault remote check            # is it reachable?
```

A bare `localhost:8787` is taken as `http://`, anything else as `https://`. Plain `http://` to a non-local host works but warns, because your login token would travel unencrypted.

**Hubs with their own certificate.** A hub served through a normal https proxy needs nothing here. A hub that serves https itself with a certificate it made for itself (see `docs/setup.md`) isn't trusted by this computer, and `envvault remote set <url>` (or `envvault init --remote <url>`) handles it the way SSH handles a new server:

- **First contact:** it prints the certificate's fingerprint once (the hub prints the same at startup) and remembers that exact certificate for that hub. No flags and no questions.
- **Afterwards:** silent. If the hub ever presents a *different* certificate, the CLI refuses to connect and says so, because that is what an impersonator looks like. If you renewed it on purpose, run `envvault remote trust`.
- **Scripts:** `envvault remote set <url> --fingerprint SHA256:…` only trusts a certificate with that fingerprint, so nothing is trusted blindly.
- **A certificate issued by your own certificate authority** can't be remembered on its own: give the CLI the authority with `envvault remote set <url> --ca ca.crt` (saved for that hub), or export `NODE_EXTRA_CA_CERTS=/path/to/ca.crt`.
- `envvault remote set <url> --verify` forgets what was trusted for a hub, and `envvault remote` shows what is trusted now.
- Remembering a certificate needs Node.js 22.19 or newer; on older versions use `NODE_EXTRA_CA_CERTS`.
- The trusted certificate is stored only in your own config, so a repository's `envvault.toml` can't add one.

For a one-off test or a CI job there is a last resort that skips the check completely: `--insecure` on a command, or `ENVVAULT_INSECURE=1`. Anyone on the network could then impersonate the hub and capture your session token, so don't use it day to day.

A login belongs to the hub it was made on. If the hub in use changes (a different `--remote`, or a repo's `envvault.toml` naming another server), the saved token is **not** sent there: you get "Not logged in to this hub" and run `envvault login` for that one.

## Command map

| Area | Commands |
|---|---|
| Account | `init`, `login`, `signup`, `recover`, `logout`, `whoami`, `trust reset` |
| Workspaces & projects | `tenants`, `use`, `list`, `project create`, `project delete` |
| Environments | `env list`, `env create`, `env delete` |
| Values | `pull`, `push`, `set`, `unset`, `get` |
| Many files at once | `tree init`, `tree list`, `tree pull`, `tree push` |
| History | `history`, `history show`, `history restore`, `history delete` |
| Access | `access list`, `access grant`, `access revoke`, `rotate` |

Every command has `--help` with its options. List commands take `--json`. When output is piped, tables become plain tab-separated lines. `NO_COLOR` turns colour off, and `--debug` shows a stack trace on errors.

## Config files: `envvault.toml` / `envvault.json`

Put an **`envvault.toml`** (or **`envvault.json`**, never both in one directory) next to your code. The CLI looks for it in the current directory and then each parent, like git finds `.git`. When it finds one:

- every command uses its `project`, `env`, `tenant`, `file` and `remote`, so plain `envvault pull` / `push` / `get` / `set` need no flags;
- run **inside a target's directory** (or below it), commands act on **that target**, so `apps/web/` pulls `apps/web/.env` from the web environment;
- run **in the directory that holds the config** with several targets, `pull` and `push` sync **all of them**. `--all` does the same from any directory below it.

Flags always win: `-p`, `-e`, `-t`, `-f` (or a positional project) make a command act on exactly what you named. Precedence: **flags → the config's target for this directory → the config's root settings → your saved defaults (`envvault init`) → `default`**.

```toml
remote = "https://envvault.example.com"
workspace = "my-team"     # must already exist on the hub
project = "my-app"        # settings cascade down the tree
env = "default"
create = true             # push creates a missing project / environment

[tree.root]
path = "."

[tree.web]
path = "apps/web"         # relative to the parent node (default: the key)
env = "staging"

[tree.web.children.api]
path = "../api"           # relative to apps/web
project = "my-api"
```

Equivalent JSON uses `"tree": { "web": { "path": "apps/web", "children": { … } } }`. `envvault tree init` writes an example.

| Key | Where | Description |
|---|---|---|
| `remote` | root | Hub URL (overrides global/project config) |
| `workspace` (or `tenant`), `project`, `env`, `file`, `merge`, `create` | root or any node | Inherited by children. `file` defaults to `.env`; `project` defaults to the node key; `merge` applies to pull; `create` applies to push |
| `path` | node | Directory, relative to the parent node |
| `sync = false` | node | Grouping directory only; children still sync |
| `children` | node | Nested nodes |

### Creating what's missing

`push` normally needs the project and environment to exist. With `create = true` in the config (or `--create` on `push` / `tree push`), a missing **project** and **environment** are created first and then filled, so a fresh hub can be set up straight from the config. Both are created under your own key like any other, so everyone with access in the workspace can open them. Creating a project also creates its `default` environment.

- **The workspace is never created.** If `workspace` names one you don't belong to, the command stops with `Workspace not found` and lists yours.
- **Nothing is overwritten.** If the name exists but you can't open it, the CLI says so instead of replacing it. Creating needs the same permission as `project create` / `env create`, and service tokens can't create.
- `tree push -n --create` shows what would be created without changing anything.

With no `tree` section, the root settings describe one target. `envvault whoami` shows which config file and target are in effect.

### `tree`

```bash
envvault tree init [--format toml|json]    # write an example config
envvault tree list [targets...]            # what each target maps to
envvault tree pull [targets...] [-n]       # hub → files (creates directories)
envvault tree push [targets...] [-n]       # files → hub
envvault tree pull -i                      # pick the targets from a list
```

Targets are named by their key path (`web`, `web/api`); naming one selects it and its subtree. `-t` overrides the workspace, `-c <file>` uses another config file, `-n` is a dry run. Several targets sync in parallel, and one failing doesn't stop the rest.

**Choosing from a list.** `tree pull -i` (and `tree push -i`) opens a checklist of the targets, with each one's project/env, your access (when logged in) and, for push, whether its file exists yet. Arrow keys move, **space** ticks, **ctrl+a** ticks or clears everything shown, typing filters the list (`hr` narrows it to the matching targets, and picks survive changing the filter), **enter** syncs the ticked ones, **esc** cancels. It combines with `-n` and `--skip-denied`, and with names to start from a subset (`tree pull -i backend`). It needs a terminal; in scripts, name the targets instead.

### When you only have access to some targets

Permissions belong to a project/environment, not to a directory, so each target is checked on its own: nesting in the config never grants or hides anything. If you can open `dir2/dir3` but not `dir1`:

- the targets you can open sync normally, and the others are reported (`✗ dir1 (app/default): No access to app/default. …`) without touching their files;
- the run still exits **1**, after finishing everything else;
- a **read-only** target pulls fine; pushing it fails with `Not allowed to write to app/dir3: Requires write access.`

`--skip-denied` (on `pull`, `push`, `tree pull`, `tree push`) reports targets you have no access to, or may only read when pushing, as `– skipped … no access` / `read-only` and exits **0**, so CI that holds only some environments doesn't fail. Real errors (network, bad config, conflicts) still fail. A summary line counts synced / skipped / failed.

To see this before running anything:

```bash
envvault tree list           # adds an ACCESS column (read, write, write + delete, manager, no access)
envvault tree pull -n       # dry run: marks targets that would fail, or be skipped with --skip-denied
```

`tree list --offline` skips the hub lookup. The hub deliberately doesn't say whether an environment you can't open exists or is just hidden from you, so "no access" covers both.

## `init`

```bash
envvault init --remote https://HUB -d my-app -e default
envvault init --remote https://HUB -d my-app --local   # project overlay only
```

| Option | Description |
|---|---|
| `-r, --remote <url>` | Hub base URL |
| `-d, --default-project <name>` | Default project |
| `-e, --default-env <name>` | Default environment (default: `default`) |
| `-l, --local` | Write remote/defaults to `./.envvault` (session stays global) |

## `signup`

```bash
envvault signup yourname --invite <code>
```

Creates your account from an administrator's invite code (the `#invite=…` part of the link). Your password stays on this machine. A **recovery key** is printed once — store it safely; it is the only way back in if you forget your password. The first account on a fresh server uses the `ENVVAULT_SETUP_TOKEN` as the code, if one is set.

## `recover` / `trust reset`

```bash
envvault recover yourname --recovery-key ABCD-EFGH-…     # forgot your password
envvault trust reset                                       # forget remembered public keys (after verifying a change)
```

`recover` signs out every other device. The CLI remembers each person's public-key fingerprint the first time it wraps a secret for them and refuses if the hub later returns a different key.

## CI/CD: service tokens

Create a token in the dashboard (Settings → Service tokens), then in CI:

```bash
export ENVVAULT_TOKEN=evt_…          # the hub URL is embedded in the token
envvault pull -p my-app -e production -f .env
```

The token is scoped to the environments you granted (read-only by default), expires, and is revoked from the same screen. It cannot log in with a password or create projects.

## `login` / `logout` / `whoami`

```bash
envvault login alice
ENVVAULT_PASSWORD='…' envvault login alice   # non-interactive (avoid shell history when possible)
envvault whoami
envvault logout
```

Login stores a session in **`~/.config/envvault/config.json`** (mode `0600`). Your private key is kept **encrypted**, with its unlock key in the OS keychain; without a keychain it is sealed with your password and each command asks for it (or reads `ENVVAULT_PASSWORD`). `logout` removes the keychain entry. See [Security](security.md#how-the-cli-stores-your-key).

## Workspaces and projects

```bash
envvault tenants                  # * marks the active workspace
envvault use acme                 # slug, id, or `personal`
envvault list                     # projects you can open
envvault list -t acme
envvault project create my-app
envvault project delete my-app    # asks you to type the name; -y skips it
```

## Environments

```bash
envvault env list -p my-app
envvault env create staging -p my-app
envvault env delete staging -p my-app      # also deletes its history; asks first (-y skips)
```

An environment needs at least one sibling to be deleted: the last one in a project can't be removed.

## Values: `pull` / `push` / `set` / `unset` / `get`

```bash
envvault pull                         # using ./envvault.toml, or saved defaults
envvault pull -p my-app -e staging -f .env.staging
envvault pull my-app --merge          # keep local-only lines
envvault push -p my-app -e default -f .env
envvault set API_KEY=secret DB_HOST=localhost
envvault set DATABASE_URL=… --group db   # put keys in a key group (a Kubernetes link takes one group)
envvault set LOG_LEVEL=info --group default   # back to no group
envvault unset OLD_KEY
envvault get API_KEY                  # one value
envvault get                          # everything, as dotenv text
```

| Option | Default | Description |
|---|---|---|
| `-p, --project` | config, then saved default | Project |
| `-e, --env` | config, then `default` | Environment |
| `-t, --tenant`, `-w, --workspace` | config, then active workspace | Workspace slug or id (it must exist) |
| `--group` (`set` only) | unchanged | Key group for the keys being set. `push`, `set`, `unset`, restore and re-key keep the groups of the keys that stay and the environment's list of group names (a push stops if it cannot read them, instead of saving without); `pull` and `get` print the values without them. |
| `-f, --file` | `.env`, or the config's `file` | Local file (`pull`, `push`) |
| `--merge` | | (`pull`) merge into the existing file |
| `--all` | | (`pull`, `push`) every target in the config |
| `-y, --yes` | | (`push`) don't ask before pushing an empty file |
| `--create` | config's `create`, else off | (`push`) create the project / environment if missing |

Writes made by `set` and `unset` are rejected if someone else changed the environment since you read it. Every `push`, `set` and `unset` keeps the previous version in the history.

## History

```bash
envvault history                       # versions, newest first
envvault history show 3                # print version 3
envvault history show 3 --diff         # what restoring it would add / remove / change
envvault history show 3 --diff --values
envvault history restore 3             # saves v3's contents as a new version
envvault history delete 3              # needs the Delete permission
```

Each save keeps the version it replaces (the newest 50 per environment). Restoring never rewrites history: it saves the old contents as a new version labelled "Restored from v3". Values are hidden in `--diff` unless you pass `--values`.

## Access and permissions

Access to an environment is a level, **read** or **write**, plus optional permissions that don't imply each other:

| Permission | Lets someone |
|---|---|
| **delete** | delete the environment or its saved versions (and the project, if held on every environment) |
| **share** | grant access to others and see who has it |
| **rotate** | re-key the environment and revoke people |

`manager` is the preset with all three. A plain **write** user can save and restore but can't delete, share or re-key.

```bash
envvault access list -p my-app -e prod
envvault access grant bob                        # read
envvault access grant bob -l write -a delete     # read, write and delete versions
envvault access grant bob -l manager             # everything
envvault access revoke bob                       # re-keys the environment for everyone else
envvault rotate -p my-app -e prod                # new key, same values
```

- You can hand out only what you hold, and can't change or revoke someone who holds more than you.
- The first time you share with someone, the CLI shows their **key fingerprint** and asks you to confirm it (`-y` accepts a first-time key). A key that has **changed** is never accepted by `-y`: check it with them first.
- `revoke` and `rotate` re-encrypt the environment and its saved versions under a new key, so the removed person's old key opens nothing. Rotation changes the key, not the secrets: if someone who saw the values leaves, change the values too.
- Granting a service token needs the dashboard.

## Local hub (`pnpm serve`)

The published npm CLI does **not** include a server. In this monorepo:

```bash
pnpm serve
# or: tsx src/index.ts serve
```

Uses SQLite by default, or Postgres via `DATABASE_URL`.

## Auth model

| | Dashboard / new CLI |
|---|---|
| Login | Username + password → session |
| Scope | Tenant → project → environment |
| Crypto | Password → keys derived locally; env DEK unwrapped with your private key; payloads encrypted/decrypted in the CLI |

The hub never receives your password or any decryption key — see [Security](security.md). `set` rejects the write if someone else changed the environment since you read it.
