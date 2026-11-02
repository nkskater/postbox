# Traffic capture

Record the HTTP requests a client, script or app makes, review them, and turn the ones you pick into
requests in a collection. Open **Settings → Execution → Traffic capture** (workspace owners and
managers).

## How recording works

Starting a session gives you a **relay URL**, shown once:

```
https://postbox.example/capture/cap_…/
```

Append the address you want to reach, with a **single slash** after the scheme, and send the request
there with any method:

```bash
curl -X POST "https://postbox.example/capture/cap_…/http:/api.internal:8080/orders" \
  -H "Authorization: Bearer …" -d '{"sku":"A1"}'
```

The web server turns a double slash in a path into a redirect, which many clients do not follow for
requests with a body, so `http:/host` (or the percent-encoded form below) is the form to use.

Postbox forwards the request, returns the real response to your client, and stores a copy for
review. Because it is the one making the connection, nothing is installed on the client and no
certificate has to be trusted. A percent-encoded target (`…/cap_…/https%3A%2F%2Fapi.example.com%2Fa`)
works too, and is safest when the target has its own query string.

This is a recording relay, not a system-wide proxy: clients must be pointed at the relay URL (a base
URL setting, an environment variable, or the address you call from a script). To record a browser
session instead, export a HAR file from the browser's network tab and add it to a session
(`POST …/entries`, below); Postbox applies the same redaction.

## What is protected

- **Credentials are removed before anything is stored.** `Authorization`, `Proxy-Authorization`, API
  key and token headers, credentials in the URL, secret-looking query parameters, and secret-looking
  fields in JSON and form bodies are replaced with `[redacted]`. Every credential value seen in a
  request is also removed wherever the response echoes it back. A Basic login is removed in its
  decoded parts as well.
- **Cookies are masked by default.** Turn on _keep harmless cookies_ per session to keep values of
  cookies that do not look like logins; names such as `session`, `sid`, `auth`, `csrf` or `token` are
  always masked.
- **HTTPS needs explicit consent.** A session records only `http://` targets until its owner turns on
  _Allow recording HTTPS traffic_. Who agreed and when is stored and audited. The relay opens the
  secure connection itself; it does not intercept anyone else's TLS or ask clients to trust a
  certificate.
- **Host filters.** A session can be limited to named hosts (`api.example.com`, `*.cdn.test`).
- **Outbound policy.** Every target passes the same host policy as the request proxy, including DNS
  resolution, so blocked or private ranges stay blocked. Redirects are not followed; the client sees
  them and decides.
- **The relay URL is the credential.** It is stored hashed, never listed, and unknown, malformed and
  stopped URLs all answer `404`. _New URL_ replaces it at once. Requests are rate limited and bodies
  are bounded (1 MiB sent, 256 KiB stored per body). Binary bodies are recorded by size only.
- **Retention.** A session keeps its newest 500 entries, and entries older than _Keep recorded traffic
  for_ (App Settings → History & data, default 14 days, 0 keeps them) are deleted automatically.

## Review and import

Open **Review** on a session to see each recorded exchange with its redacted headers and bodies.
Tick the entries you want and choose **Create requests**: they become requests in a new folder, with
the captured response saved as an example. Credentials were removed, so add authentication (for
example a vault secret reference) before sending them. Failed exchanges are listed but cannot be
imported. **Download HAR** exports the redacted recording.

## Automation

| Task                                | REST                                                             | MCP                     |
| ----------------------------------- | ---------------------------------------------------------------- | ----------------------- |
| List / create sessions              | `GET`/`POST /api/capture/sessions`                               | `list_capture_sessions` |
| Pause, resume, stop, change opt-ins | `PATCH /api/capture/sessions/:id` (`status`, `allowHttps`, …)    |                         |
| Replace the relay URL               | `POST /api/capture/sessions/:id/rotate`                          |                         |
| List / read entries                 | `GET /api/capture/sessions/:id/entries[?entry=<id>]`             | `list_capture_entries`  |
| Add a HAR file                      | `POST /api/capture/sessions/:id/entries` `{ "har": {…} }`        |                         |
| Delete entries                      | `DELETE /api/capture/sessions/:id/entries` `{ "entryIds": […] }` |                         |
| Export HAR                          | `GET /api/capture/sessions/:id/export[?entries=a,b]`             |                         |
| Create requests                     | `POST /api/capture/sessions/:id/requests` `{ "entryIds": […] }`  | `capture_to_requests`   |

Session creation and changes (including the HTTPS consent) are audited. Credentials, the relay
token and recorded bodies never appear in the audit trail.

## Not included

A system-wide or browser-integrated proxy that intercepts other applications' HTTPS (which would
need a locally trusted certificate authority), and browser cookie synchronisation, are not part of
this feature. Use a HAR export from the browser instead.
