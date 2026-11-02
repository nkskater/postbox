# Secrets vault

Store API keys, passwords and tokens encrypted, reference them from requests, and keep them out of history, results,
exports and backups. Open **Settings → Variables & secrets → Secrets vault**, or use the REST API, the CLI or MCP.

## Using a secret

Store it once (name, value, optional description), then write `{{vault:name}}` anywhere a variable works: URL, headers,
query parameters, bodies, auth fields, `pm.sendRequest` and saved-request runs.

```
Authorization: Bearer {{vault:stripe-live}}
```

- The reference is resolved only while the request is sent. The stored request, history, run results, console and
  reports show the reference or `********`, never the value. Values are masked wherever a response echoes them back.
- The `vault:` prefix is reserved: an ordinary variable can never stand in for, or shadow, a vault secret.
- A secret that does not exist, is not available to the collection, or cannot be decrypted stays as the literal
  `{{vault:name}}` and is reported as an unresolved variable. Nothing is guessed.
- Generated code snippets keep `{{vault:name}}`; decrypted values never leave an execution.

## Access

- **Collections.** A secret is available in the whole workspace, or only in the collections you tick. A request in another
  collection cannot resolve it.
- **Roles.** Viewers can see names and settings; editors can add, replace, scope and delete secrets; only owners can run
  the migration. Nobody can read a value back through the UI, REST API, CLI or MCP. Replace it to change it.
- **Scripts.** Scripts cannot read secrets by default. Tick **scripts may read it** (`scriptAccess`) and a script can call
  `pm.vault.get("name")` / `pm.vault.has("name")`. The vault is not a variable scope: `pm.variables`, `pm.environment`
  and `replaceIn` never contain vault values. `pm.vault.set` and `unset` are not supported.
- **MCP.** The tools list and delete secrets but cannot create or read values, so a value never passes through a
  model's context.

## Encryption and keys

Each value is encrypted with AES-256-GCM and a fresh random nonce. The secret's workspace and name are authenticated
along with it, so a ciphertext copied to another secret or workspace fails to decrypt. The key is **not** in the database
or in backups. It comes from, in order:

1. `POSTBOX_VAULT_KEY`: 32 bytes as base64 or 64 hex digits (generate one with `openssl rand -base64 32`). List older
   keys that still protect values in `POSTBOX_VAULT_PREVIOUS_KEYS` (comma separated).
2. `POSTBOX_VAULT_KEY_FILE`: path of a key file, created on first use.
3. `vault.keys.json` next to the database file, created on first use with mode 0600.

Option 3 is convenient but keeps the key on the same disk as the database. Use option 1 or 2 (or mount the key from
other storage) when a copy of the data directory should not be enough to read secrets. **Lose the key and the secrets are
gone.** Back it up separately from database backups. Nothing is created until you store the first secret.

### Rotation

**Settings → Secrets vault → Encryption key** (administrators), `POST /api/admin/vault/rotate`, or `postbox vault rotate`:

- _Create new key and re-encrypt_ (key files): adds a key, makes it current and re-encrypts every secret.
- _Re-encrypt under the current key_: for `POSTBOX_VAULT_KEY` setups. Put the new key in `POSTBOX_VAULT_KEY`, the old one
  in `POSTBOX_VAULT_PREVIOUS_KEYS`, restart, then re-encrypt. Remove the old key afterwards.
- _Remove unused keys_ (key files): drops keys no secret uses. Refused while any secret needs a key that is unavailable.

A secret whose key is missing is shown as **unreadable** and is skipped at use. Replacing a value (`PATCH` with `value`)
rotates that secret on its own. Deleting a secret removes its ciphertext.

## Existing secret variables

Variables marked secret keep their value as plain text in SQLite. **Move secret variables into the vault** (or
`postbox vault migrate`, `POST /api/vault/migrate`) creates a vault secret for each (named like `environment.Prod.token`
or `collection.<id>.password`) and leaves `{{vault:name}}` in the variable. Requests keep working unchanged. A collection
variable's secret is limited to that collection. Scripts that read such a variable now get the reference; pass
`scriptAccess` (CLI `--script-access`) to also allow `pm.vault.get`. Running it again skips what is already moved.

## Backups and exports

- A full backup holds the ciphertext (and key ids), which is useless without the key. Restoring it on a server with the
  same key works; on another server the secrets show as unreadable until that key is configured.
- A backup made without secrets holds **no** ciphertext. After restoring it each secret is marked _needs a value_; replace
  the values.
- Mock exports, collection exports and documentation never include vault values. Audit entries name the secret and the
  setting that changed, never the value.

## Limits

500 secrets per workspace, 16 KiB per value, names of 1-64 letters, digits, `_`, `.` or `-`.

## CLI

```sh
printf %s "$KEY" | postbox vault set stripe-live -w <workspace> --script-access --collection <collectionId>
postbox vault set db-password --value-file ./pw.txt        # replaces an existing secret of that name
postbox vault list -w <workspace>
postbox vault delete stripe-live -w <workspace>
postbox vault migrate -w <workspace>
postbox vault status                                       # administrators
postbox vault rotate --new-key --prune                     # administrators
```

Values are read from standard input or a file, never from arguments.

## REST

| Method and path                   | Behavior                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/vault?workspaceId=`     | Names, descriptions, scope and state; no values                               |
| `POST /api/vault`                 | `{workspaceId, name, value, description?, scriptAccess?, collectionIds?}`     |
| `GET/PATCH/DELETE /api/vault/:id` | Metadata; replace the value, rename, change scope; delete                     |
| `POST /api/vault/migrate`         | `{workspaceId, scriptAccess?}` move secret variables into the vault           |
| `GET /api/admin/vault`            | Key source, current key id, secrets per key (no key material); administrators |
| `POST /api/admin/vault/rotate`    | `{newKey?, prune?}` re-encrypt; administrators                                |
