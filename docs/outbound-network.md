# Outbound proxy, custom CAs and client certificates

Administrators can send Postbox's outgoing traffic through an HTTP(S) proxy and give it the certificates it needs
for private services. Open **Settings → Request execution** (administrators only), or use the API under
`/api/admin/outbound/`.

## What applies where

| Client                                                                                              | Proxy                                                                       | Custom CA / client certificate |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------ |
| HTTP requests (HTTP/1.1, HTTP/2), redirects, OAuth token calls, webhooks, imports, `pm.sendRequest` | yes                                                                         | yes                            |
| Server-sent events                                                                                  | yes                                                                         | yes                            |
| WebSocket, Socket.IO, GraphQL subscriptions                                                         | yes (CONNECT tunnel, also for `ws://`)                                      | yes                            |
| gRPC, MQTT                                                                                          | **refused** for hosts that would use the proxy: add them to the bypass list | yes                            |
| Unix sockets and named pipes                                                                        | no (no network)                                                             | https over a socket: yes       |
| NTLM, cleartext HTTP/2 (`h2c`)                                                                      | refused through a proxy                                                     | n/a                            |

SOCKS proxies are not supported. The `postbox` CLI does not read these settings; it talks to a server that does.

## Proxy

`http://` and `https://` proxies, optional Basic credentials, and a bypass list using the same patterns as
`PROXY_ALLOW_HOSTS` (names, `*.domain`, addresses, CIDR ranges). Credentials go in their own fields, not the URL.

- `http://` targets are sent to the proxy in absolute form.
- `https://`, WebSocket and Socket.IO targets use `CONNECT`; TLS is negotiated end to end with the target, so the
  proxy never sees decrypted traffic, and the target certificate is verified (or not) as for a direct request.
- A `407` is reported as a proxy authentication failure; a refused `CONNECT` names the status.
- Redirects are checked hop by hop, and bypass is decided per hop.

## Host policy through a proxy

Direct connections check the host name **and every resolved address**, which stops DNS rebinding. A proxy resolves
the name itself, so Postbox can only check the name. The rules, per target:

1. `PROXY_DENY_HOSTS` entries that name the host (or a parent wildcard) block it, and literal IP targets are checked
   against every rule as usual.
2. With a `PROXY_ALLOW_HOSTS` list, the name must match it **by name or wildcard**. Address and CIDR allow entries
   cannot admit a name that the proxy resolves.
3. If `PROXY_DENY_HOSTS` contains addresses or ranges (for example `10.0.0.0/8`, to keep private networks out), they
   cannot be enforced on a name. The name is then allowed only when it is listed **by name** in `PROXY_ALLOW_HOSTS`
   (`*` is not enough); otherwise the request fails with an explanation.
4. Add a host to the bypass list to connect directly, where the full address check applies again.
5. The proxy's own address is trusted: only administrators can set it, and an internal proxy usually sits in a range
   that the deny list covers. It is not checked against the allow or deny lists.

**Settings → Request execution → Active host policy** shows the rules read-only, with these notes.

## Certificates and mutual TLS

A **TLS profile** lists host patterns (`host`, `*.domain` or `host:port`) and holds any of:

- a **CA certificate bundle**, trusted _in addition to_ the system roots;
- a **client certificate and private key** (with an optional passphrase), presented when the server asks.

The most specific match wins: `host:port`, then an exact host, then a wildcard. Saving checks that the PEM parses, that
the key matches the certificate and that an encrypted key's passphrase works.

## Secrets

The proxy password, private keys and passphrases are write-only: the API never returns them (it reports whether a
password or passphrase is set, and describes certificates by subject, issuer, expiry and fingerprint). Audit entries
name the field that changed but not its value. They are stored in the database like other secret values, so protect the
database file and backups.

A backup includes the proxy and profiles. A backup made without secrets drops the proxy password, private keys and
passphrases; restoring it keeps the CA bundle but drops client certificates whose key is missing. A restored proxy URL
that no longer parses is dropped rather than breaking every request.

## API

All routes are administrator-only.

- `GET | PUT | DELETE /api/admin/outbound/proxy`: `{ url, enabled?, username?, password?, bypass? }`. Omit `password` to keep it,
  send `""` to clear it.
- `GET | POST /api/admin/outbound/tls-profiles`, `GET | PATCH | DELETE /api/admin/outbound/tls-profiles/:id`:
  `{ name, hosts, ca?, cert?, key?, passphrase? }`. In a `PATCH`, omitted fields keep their value and `""` removes one.
- `GET /api/admin/outbound/policy`: the active allow, deny and socket rules, the proxy, and the proxy semantics above.
