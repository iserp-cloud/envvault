# Security model

EnvVault is **zero-knowledge for secrets**: encryption and decryption happen in the dashboard (browser) and CLI. The hub stores and serves ciphertext and cannot read your environment variables or your password.

## What the server sees

| Server **can** see | Server **cannot** see |
|---|---|
| Usernames, workspace / project / environment **names** | Environment variable **keys and values** |
| Who has access to what (ACLs), timestamps, sizes | Your **password** |
| Public keys, wrapped (encrypted) DEKs | Your **private key**, any environment DEK |
| A hash of your login proof (`authKey`) | Anything derived from your password except that proof |

## Key hierarchy

```text
password ──Argon2id (64 MiB, t=3; salt = username)──▶ master
master ──HKDF──▶ authKey   → sent to the server as the login proof (stored only as a salted HMAC)
master ──HKDF──▶ wrapKey   → never leaves the client; AES-GCM-seals the private key
RSA-OAEP-3072 identity keypair: public key on the server, private key stored sealed with wrapKey
Environment DEK (AES-256): random per environment, wrapped (RSA-OAEP) to each member's public key
Environment payload: JSON sealed with the DEK (AES-256-GCM), AAD = tenant|project|environment
```

- Login sends only `authKey`. A stolen database cannot be used to log in, and (with `ENVVAULT_PEPPER` set) cannot even be used to test password guesses offline.
- The AAD binds each ciphertext to its location, so the server can't swap payloads between environments.
- Passwords are stretched **client-side**, so server CPU limits (e.g. Cloudflare Workers Free) no longer constrain the work factor.

## Sharing and revocation

- **Grant:** someone with the *share* permission wraps the environment DEK for the grantee's public key. They can give out no more than they hold, and can't rewrite the access of someone who holds more than they do.
- **Key generations:** every rotation starts a new key generation. A grant carries the generation of the key it was wrapped from, and the hub checks it in the same transaction as the grant, so sharing from a key that was rotated meanwhile is refused (reload and share again) instead of leaving the recipient with a key that opens nothing.
- **Revoke / remove member / revoke service token:** the client **rotates** the environment key — fresh DEK, payload re-encrypted, re-wrapped only for remaining members — in one atomic call. A removed person's old DEK cannot decrypt the new ciphertext.
- Rotation does not un-leak values they already saw. **Rotate the secrets themselves** (API keys, passwords) when someone with access leaves.
- **Version history** is stored as ciphertext under the environment's current key. On rotation the client re-encrypts every kept version under the new key (versions it can't re-encrypt are dropped; if the history is too large for one request, the oldest versions are dropped too, and the client says how many, so a revoking rotation never fails on size), so a removed member's copy of the old key opens neither current data nor history. Previous versions can't be forgotten by whoever already read them — rotate the actual secret values if they were exposed. Anyone granted access later can read the whole retained history, so delete old versions you don't want them to see. The CLI's `push` creates versions like any save; a CLI that rotates would need to send the re-encrypted history too.
- Removing a member rotates every environment they could read that you may rotate; any you can't are reported so someone with the *rotate* permission can finish. Revoking through a rotation likewise requires holding at least the revoked person's access.

## Accounts, admins, invites

- The first account becomes the instance **administrator**. `ENVVAULT_SETUP_TOKEN` (optional) makes that first signup require a secret, so nobody else can claim a freshly deployed server.
- `ENVVAULT_SIGNUP=open | invite | closed` (default `invite`). Invites are single-use, expiring, revocable; only a SHA-256 of the token is stored, and the link carries it in the URL **fragment** so it isn't sent in a GET.
- Admins can disable users (sessions are revoked immediately), change roles, and cannot remove the last active administrator.
- Sessions: 256-bit random tokens, stored hashed, 30-day expiry; a password change signs out every device.

## Forgotten passwords: the recovery key

Every account gets a random 256-bit **recovery key** at signup (shown once, you must confirm you saved it). It independently seals your private key, so you can set a new password without anyone's help:

- The server stores only a salted hash of a proof derived from the recovery key plus the recovery-sealed private key. It cannot use either to read your data.
- Recovering signs out every device. You can issue a new recovery key any time (account menu → *New recovery key*); the old one stops working. This asks for your password: a stolen session alone can't replace the recovery key and then use it to take the account over.
- If you lose **both** your password and your recovery key, your data is unrecoverable by design. A workspace owner/admin can re-grant environments to a new account.
- Anyone holding your recovery key can take over your account — store it like a password.

## Key verification (trust on first use)

When a client wraps a secret for someone, it remembers the fingerprint of their public key (browser storage / CLI config). If the server later hands back a *different* key for that person, the client **refuses** (creating projects, rotating) or **warns and asks you to confirm** (granting), instead of silently encrypting to it. The first time you share with someone, the dashboard shows their fingerprint so you can compare it with what they see under *account menu → Key fingerprint*. Clients also verify that the public key the server returns for **you** really matches your private key, and never use the server's copy of your own key.

If a key legitimately changed (account recovered or reset), verify the new fingerprint with them, then *Reset trusted keys* (dashboard) or `envvault trust reset` (CLI).

## How the CLI stores your key

The CLI never writes your decrypted private key to disk.

- **OS keychain (default):** the key is sealed in `~/.config/envvault/config.json` with a random device key held in the macOS Keychain, Windows Credential Manager or the Linux Secret Service. The config file on its own is useless, and `envvault logout` deletes the keychain entry.
- **No keychain** (headless Linux, `ENVVAULT_KEYCHAIN=off`): only the hub's password-sealed copy is stored, and each command unlocks it with your password (prompt, or `ENVVAULT_PASSWORD`). For automation use a service token instead.
- Service tokens (`ENVVAULT_TOKEN`) live in the environment and are never persisted.
- Config files written by older versions contained the plaintext key; the CLI moves it into protected storage on the next run (or warns if there is no keychain to move it to).

Malware running as you can still read what you can read — a keychain stops casual disk theft, backups and stray copies of the config file, not a compromised session. Use full-disk encryption.

## Service tokens (CI/CD)

Workspace owners/admins can create **service tokens** (Settings → Service tokens) for machines:

- The keypair is generated in your browser; the private key lives only inside the token string (`evt_…`). The server stores the public key and a hashed bearer token.
- Access is granted per environment (read or read/write) by wrapping the DEK for the service key — exactly like a human grant. Anything not granted stays unreadable.
- Tokens expire (30 days – 1 year). They cannot sign in with a password, create workspaces/projects, invite people or administer anything.
- Revoking kills the token immediately and rotates the environment keys it could read.
- Use in CI: `ENVVAULT_TOKEN=evt_… envvault pull -p app -e prod` (the hub URL is inside the token).

## Abuse protection and sessions

- **Rate limits live in the database** (shared across replicas, survive restarts) and use the real client address. `X-Forwarded-For` is **ignored unless you declare trusted proxies** (`ENVVAULT_TRUSTED_PROXIES`), so it can't be forged to dodge limits or poison the audit log.
- **Per-account throttling:** repeated failed sign-ins throttle an account for 15 minutes regardless of source address — except from addresses that have signed in to it before, so an attacker can't use the throttle to lock the owner out.
- **Devices:** Settings → *Signed-in devices* lists every active session (address, browser, time) with per-device revoke and *Sign out all other devices*. Sessions last 14 days by default.
- **Idle lock and refresh:** the dashboard clears its in-memory keys after 15 minutes without input. The decrypted private key lives in memory; for a short grace window (10 minutes after your last input, `REFRESH_GRACE_MINUTES` in `dashboard/src/api.ts`) it is also kept in this tab's `sessionStorage` so a page refresh doesn't ask for the password again. That copy is readable by script running on the page and by anyone at the open browser, so set the constant to 0 to keep the key in memory only. Locking, signing out, the idle lock, an expired session and closing the tab all wipe it. After a lock, or a refresh outside the window, you see an "Unlock" screen and re-enter your password. Unlocking is a normal sign-in (the password is proved to the hub and throttled like any login), so a stolen session token can't be used to fetch your sealed key for offline guessing. The session token is kept in `sessionStorage` — this tab only, gone when it closes — only so the previous session can be retired on unlock and the username shown. *Sign out* revokes the session on the hub (best effort: if you're offline it just expires). Tabs duplicated from one another share a token, so locking one doesn't lock the other.
- **Pending key rotations:** removing a member (or revoking a service token) flags every environment they could read until someone with the rotate permission re-keys it; the dashboard shows a *Key rotation pending* banner with a one-click *Rotate key now*, so a failed or skipped rotation can't be forgotten.
- **First-run setup token:** a fresh hub won't let the first visitor claim the admin account without a setup token (printed in the Node server log, or `ENVVAULT_SETUP_TOKEN` on Workers). With none configured, the first account can't be created at all.
- **Permissions:** access is a level (`read` or `write`) plus optional permissions that don't imply each other. *Delete*: remove the environment or its saved versions (and, held on every environment, the project). *Share*: grant access and see who has it. *Rotate*: re-key and revoke. `manager` is the preset with all three. Plain `write` can save and restore but can't delete anything, share it, or re-key it; deleting variables in the editor only adds a version, so the old values stay in history. The hub enforces these on each action; read access itself is cryptographic, so taking it back still means rotating the key.
- **Access rules:** a workspace owner's access can't be changed by a manager; new environments are keyed only for the owner, admins and the creator (everyone else is granted explicitly); pending invitees can't act on projects; deleting a workspace disables its service accounts; the last active administrator can't be removed even by two simultaneous requests.

## Audit log

The server records who did what, when and from which IP: sign-ins (including failures), signups, recoveries, password changes, secret **reads**, saves, grants, rotations, project/workspace changes, invites, admin actions and service-token activity. It never records values, keys or passwords. Instance admins see everything (Administration → Server activity); workspace owners/admins see their workspace (Settings → Workspace activity). Events are kept for 365 days by default (`ENVVAULT_AUDIT_RETENTION_DAYS`). Each entry carries an HMAC (keyed by `ENVVAULT_PEPPER`), and *Administration → Verify integrity* flags entries edited by someone with only database access. Deleted entries are not detectable — ship logs off-box if that matters.

## What gets printed

Logs and terminals are where secrets usually leak, so output is filtered:

- The hub logs failures as one line, `[tag] Name [code]: message`. It never logs the raw error object, which can carry request data or a database `detail` such as `Key (username)=(…)`.
- Everything printed passes through `redactSecrets` (`packages/shared/src/redact.ts`): passwords in URLs (including ones containing `@`), `Bearer` tokens, `evt_…` service tokens, and the value of any field named like a password, token, pepper, secret or key.
- The database is shown as `user:***@host:port/db?sslmode=…`, never with its password or other parameters.
- CLI errors and `--debug` stack traces are redacted the same way. `envvault get`, `history show --values` and `signup`'s recovery key do print secrets, because that is what you asked for.
- The one secret the hub prints on purpose is the **first-run setup token**. If your logs are collected, set `ENVVAULT_SETUP_TOKEN` from a Secret instead, so none is generated, and unset it once the first account exists.

## Remaining limitations

Not done, on purpose or for lack of a safe way:

- **No second factor (2FA/passkeys).** Accounts rely on a strong password plus the recovery key. Choose passphrases and consider enforcing them with your IdP-less workflow.
- **The recovery key is a single credential** with no notification or waiting period (there is no email system).

Inherent / external:

These can't be fixed in code alone:

1. **A malicious server can serve malicious JavaScript.** Like all browser-based E2EE, the dashboard is trusted code delivered by the server. Key pinning limits what a tampered server can do after you've first seen someone's key, but a server that rewrites the page itself can defeat any browser client. For the strongest guarantees use the CLI (distributed via npm, independent of the hub) or host the dashboard separately from the data. Keep the hub on HTTPS with a Content-Security-Policy (already set).
2. **Metadata is not hidden:** usernames, workspace/project/environment names, membership, access patterns and payload sizes are visible to the server (and to the audit log, by design).
3. **First-contact trust.** Pinning protects subsequent use; the very first key you see for someone is only as trustworthy as the fingerprint check you do with them.
4. **Unaudited.** The cryptography uses standard primitives (WebCrypto AES-GCM, RSA-OAEP, HKDF; Argon2id via the `hash-wasm` library), and the test suite exercises the flows, but this code has **not had an independent security review**. For high-value secrets, get one before relying on it.
5. **Lost password + lost recovery key = lost data.**

## Operating it safely

- Serve over HTTPS (or a VPN/SSH tunnel). Terminate TLS at your ingress, then set `ENVVAULT_HSTS=true` and `ENVVAULT_TRUSTED_PROXIES` — see [Deploying](deploy.md).
- Always use TLS to Postgres (`sslmode=verify-full`).
- Set `ENVVAULT_PEPPER` to a long random value (kept outside the database). It is **required in production** — the hub refuses to start without it. Changing it later invalidates all logins, so back it up.
- Back up the database; it contains only ciphertext, so backups are safe to store but unrecoverable without users' passwords or recovery keys.
- Run `pnpm audit --prod` and `pnpm test` before each release, scan the image (for example `trivy image`), and pin it by digest. There is no CI in this repo, so these are manual.
- Prefer service tokens scoped to the single environment each pipeline needs, with short expiries.

## Upgrading from the previous (server-side encryption) version

The data model is incompatible: the old server could decrypt data using keys sent per request, and passwords were verified server-side. There is no way to migrate without each user's password, so start a **new database**; the server refuses to start against an old one with a clear error.
