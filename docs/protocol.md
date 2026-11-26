# Protocol: reading an environment (schema `zk-6`)

What any client must do to read an environment with a service token. The TypeScript clients
implement all of `packages/shared/src/zk.ts`; a second implementation (the Kubernetes operator,
written in Go) needs only this decrypt path. `test/vectors/zk-6.json` holds fixed inputs and the
plaintext they must produce. Both languages' tests read that file, so the two cannot drift
silently. Changing anything below means a new schema version and new vectors.

Encodings: **base64** is standard with padding; **base64url** is the URL-safe alphabet without
padding. All text is UTF-8.

## 1. The service token

`evt_` followed by base64url of this JSON:

| Field | Meaning |
|---|---|
| `v` | `1` (reject anything else) |
| `u` | service account username |
| `t` | bearer token for the hub |
| `k` | RSA private key, PKCS8, **base64** |
| `w` | workspace (tenant) id |
| `r` | hub origin, e.g. `https://hub:30847` |

All of `v u t k w r` must be present and non-empty. The token is encoded, not encrypted.

## 2. Talking to the hub

oRPC's RPC wire format, one call per request:

```
POST {r}/rpc/{router}/{procedure}
authorization: Bearer {t}
content-type: application/json

{"json": <input>}
```

The reply is `{"json": <output>}` on success. Errors come back as a non-2xx status with
`{"json": {"defined": false, "code": "...", "status": 403, "message": "...", "data": ...}}`. The hub never says whether something is missing or
hidden from you: treat `NOT_FOUND` and `FORBIDDEN` as "no access".

Two calls read an environment (`tenantId` is the token's `w`):

1. `environments/list` with `{tenantId, project}` returns an array of
   `{name, updatedAt, level, caps, wrappedEnvDek, keyVersion, rotatePending}`.
   Pick the row whose `name` is the wanted environment; its `wrappedEnvDek` is the key for you.
2. `environments/getEnv` with `{tenantId, project, name}` returns
   `{tenantId, projectName, name, updatedAt, payload}`, where `payload` is a sealed box.

Every call is recorded in the hub's audit log (`env.read`). Polling is therefore visible.

## 3. Opening it

1. **Unwrap the environment key.** `wrappedEnvDek` is base64 RSA-OAEP, SHA-256, MGF1-SHA-256,
   empty label, under the private key `k`. The result is UTF-8 text: a **base64url** string of
   32 bytes, the AES-256 key.
2. **Compute the AAD** (a UTF-8 string) from the values the hub returned in `getEnv`:
   `envvault:env:v1|{tenantId}|{project}|{name}`
3. **Open the sealed box** `{v, iv, ct}`:
   - reject unless `v == 1`
   - `iv`: base64url, 12 bytes
   - `ct`: base64url, ciphertext followed by a 16-byte GCM tag
   - AES-256-GCM, the AAD above, 128-bit tag
4. **Parse the plaintext** as a JSON object whose keys and values are all strings. Anything else
   is a corrupt payload.

If any step fails, fail closed: change nothing and report that the environment could not be
opened. Never write partial results.

## 4. What must be rejected

The vectors include cases that must fail: a different location in the AAD, `v: 2`, and a flipped
ciphertext byte. A wrong AAD is the protection against the hub swapping payloads between
environments, so an implementation that skips the AAD is broken.

## Not covered here

Account creation, passwords, recovery keys, key wrapping for new members and writing
environments are done only by the TypeScript clients. A reader implementation does not need them.
