# Management API examples

- `client.mjs` — a dependency-free JavaScript client (`PostboxClient`) covering the common calls and the
  streaming `runCollection`. It is exercised by `tests/management-api.test.ts` on every build.
- `curl.sh` — the same flow with curl.

Set `POSTBOX_URL` and `POSTBOX_TOKEN` first. Full reference: [`docs/management-api.md`](../../docs/management-api.md).
