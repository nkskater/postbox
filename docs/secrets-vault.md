# Secrets vault

Store API keys, passwords and tokens encrypted, reference them from requests, and keep them out of history, results,
exports and backups. Open **Settings → Variables & secrets → Secrets vault**, use the lock button on any password or
token field, or use the REST API, the CLI or MCP. It works like Postman's vault: values live in one encrypted place,
requests only hold a `{{vault:name}}` reference, and a secret can be limited to the hosts it is meant for.

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

## Move a value into the vault from the editor

Every masked field (basic and digest passwords, bearer and API-key tokens, OAuth secrets and so on) has a lock button.
Press it, name the secret (and optionally the hosts it may be sent to), and the value is stored encrypted while the field
keeps `{{vault:name}}`. Values that are empty, already references, or mix in other variables are not offered.

## Allowed domains

A secret can list the hosts it may be sent to (`api.example.com`, `*.example.org` for any subdomain, or an IP address;
ports are ignored). A request to any other host is **refused before anything is sent**, even if the secret was put there
by hand: the check looks at the URL, headers (including Basic credentials), body and every redirect hop, and also covers
scripts and `pm.sendRequest`. This stops a mistyped URL, a redirect, an edited shared collection or a script from sending
a key to the wrong server. With no domains a secret works with any host. `*` alone is not accepted.

## Access

- **Collections.** A secret is available in the whole workspace, or only in the collections you tick. A request in another
  collection cannot resolve it.
- **Personal secrets.** Tick _Only me_ (or `postbox vault set --personal`) and only executions you start can use the
  secret. Nobody else, including workspace owners and administrators, can see it in a list or read, change or delete it.
  It cannot be turned into a workspace secret later. A personal secret replaces a workspace secret of the same name for
  you. Schedules, webhooks and other unattended work run without a user, so they never see personal secrets.
- **Enable and disable.** Untick a secret to switch it off without deleting it; its references stay unresolved until you
  turn it back on.
- **Roles.** Viewers can see names and settings; editors can add, replace, scope, restrict and delete secrets; only
  owners can run the migration and export.
- **Viewing a value.** Lists and reads never include values. The person who created a secret, or a workspace owner (for a
  personal secret, only its owner), can press **Show value** (`POST /api/vault/:id/reveal`, `postbox vault reveal`). The
  value is shown for 15 seconds, and every reveal is recorded in the audit log without the value.
- **Scripts.** Scripts cannot read secrets by default. Tick **scripts may read it** (`scriptAccess`) and a script can call
  `pm.vault.get("name")` / `pm.vault.has("name")`, and `pm.vault.set("name", value)` to replace its value (for example
  to store a refreshed token). `set` cannot create secrets, so a collection cannot plant new ones, and it only works on
  secrets with script access; `unset` is not supported. The vault is not a variable scope: `pm.variables`,
  `pm.environment` and `replaceIn` never contain vault values. Changes are saved when the request or run finishes.
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

## Export and import

**Export encrypted file** (workspace owners; `postbox vault export --out vault.json --passphrase-file pass.txt`,
`POST /api/vault/export`) writes every secret you can see into a file protected by a passphrase of at least 8
characters (scrypt key derivation, AES-256-GCM). Use it to move secrets to another server, or to bring them back after
restoring a backup made without secrets. A plaintext export needs `plaintext` and `acknowledgePlaintext` in the API and
puts every value in the file; it is not offered in the UI. Wrong passphrases and altered files are both rejected.

**Import** (editors; `postbox vault import vault.json`, `POST /api/vault/import`) adds the secrets. Names that already
exist are skipped, replaced or kept side by side (`-2`, `-3`, ...) as you choose. Collections travel by name: a secret
whose collection does not exist on the destination is imported **disabled**, with a warning, rather than wider than
intended. Both actions are audited without values.

## Backups and exports

- A full backup holds the ciphertext (and key ids), which is useless without the key. Restoring it on a server with the
  same key works; on another server the secrets show as unreadable until that key is configured.
- A backup made without secrets holds **no** ciphertext. After restoring it each secret is marked _needs a value_; replace
  the values.
- Mock exports, collection exports and documentation never include vault values. Audit entries name the secret and the
  setting that changed, never the value.

## Limits

500 secrets per workspace, 16 KiB per value, 20 domains per secret, names of 1-64 letters, digits, `_`, `.` or `-`.

## CLI

```sh
printf %s "$KEY" | postbox vault set stripe-live -w <workspace> --script-access --collection <collectionId>
postbox vault set db-password --value-file ./pw.txt        # replaces an existing secret of that name
postbox vault list -w <workspace>
postbox vault set stripe-live --value-file ./key.txt --domains "api.stripe.com" --personal
postbox vault reveal stripe-live -w <workspace>             # prints the value; audited
postbox vault export --out vault.json --passphrase-file pass.txt -w <workspace>
postbox vault import vault.json --passphrase-file pass.txt --on-conflict rename -w <workspace>
postbox vault delete stripe-live -w <workspace>
postbox vault migrate -w <workspace>
postbox vault status                                       # administrators
postbox vault rotate --new-key --prune                     # administrators
```

Values are read from standard input or a file, never from arguments.

## REST

| Method and path                   | Behavior                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/vault?workspaceId=`     | Names, descriptions, scope and state; no values                                                          |
| `POST /api/vault`                 | `{workspaceId, name, value, description?, scriptAccess?, collectionIds?, domains?, enabled?, personal?}` |
| `GET/PATCH/DELETE /api/vault/:id` | Metadata; replace the value, rename, change scope; delete                                                |
| `POST /api/vault/migrate`         | `{workspaceId, scriptAccess?}` move secret variables into the vault                                      |
| `GET /api/admin/vault`            | Key source, current key id, secrets per key (no key material); administrators                            |
| `POST /api/admin/vault/rotate`    | `{newKey?, prune?}` re-encrypt; administrators                                                           |
