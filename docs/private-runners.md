# Private runners

A private runner executes your monitors from inside another network (a data centre, an office, a VPC), so you
can watch internal APIs and see how they look from there. It is a small process you run with the Postbox CLI.
It connects **out** to your Postbox server over HTTPS; nothing connects in, and no vendor cloud is involved.

## Set up

1. In **Monitors → Private runners → Add runner** (or `postbox runner create`), name the runner and say where
   it sits. The **token** is shown once. Only its hash is stored.
2. On a machine inside the target network:

```sh
export POSTBOX_RUNNER_TOKEN=pbr_...
postbox runner start --server https://postbox.example.com
```

3. Edit a monitor and choose the runner under **Where it runs** (or
   `postbox runner assign <monitorId> --runner <runnerId>`; `--server` moves it back). Each result in the
   monitor's history says which runner took it.

```sh
postbox runner list -w <workspace>
postbox runner create "dc-east" --location "Frankfurt DC" --labels dc,prod --deny-hosts 169.254.169.254
postbox runner update <id> --location "Frankfurt DC 2"
postbox runner revoke <id>          # stop it connecting; unfinished checks are recorded as failed
postbox runner delete <id>          # only when no monitor uses it
postbox runner start --server <url> [--once] [--poll 5] [--token-env NAME]
```

`start` needs an `https://` server (plain `http://` only for localhost, or with `--allow-insecure`, because the
token would otherwise be readable on the wire). It stops with exit code 3 when the token is wrong or revoked,
and keeps retrying with backoff when the server cannot be reached.

## How a check travels

The server's scheduler (or **Run check now**) queues one job for the monitor's runner. The runner polls for
work (`POST /api/runner-agent/lease`, which is also its heartbeat), receives the collection, environment and
limits as a Postman export, runs it locally and posts back the **metrics** (requests, availability, assertions,
p95 latency), never response bodies. The server applies the monitor's rules to those metrics exactly as it does
for a check it ran itself, so incidents, recoveries, webhooks and email behave the same.

- **Leases.** A job is leased for 60 seconds and the runner extends it every 20 seconds while it works. If the
  runner goes silent the job is handed out again, up to 3 attempts, then the check is recorded as failed
  ("Runner stopped responding after 3 attempts"). A job nobody picks up within 5 minutes is recorded as failed
  ("Runner is offline"). Both open incidents like any other failing check.
- **No double counting.** Every job has one `runId`, which is also its idempotency key. If a result is lost on
  the way (the runner retries) or delivered twice, it is recorded once. A runner that finishes after its lease
  was taken away is told to stop on its next heartbeat, and its late result is still accepted once.
- **One at a time.** A monitor never queues behind its own unfinished check; that run is skipped with a 409.
- **Status.** A runner is **online** if it called in within 90 seconds, **offline** otherwise, **revoked** once
  revoked.

## Secrets and policy per runner

- **Secrets stay home by default.** Unless the runner was created with _Send secret values to this runner_
  (`--share-secrets`), secret variables and auth credentials are blank in what it receives. The runner supplies
  its own with environment variables: `POSTBOX_RUNNER_VAR_apiKey=...` becomes the variable `apiKey` and overrides
  any same-named variable from the server. `{{vault:...}}` references are not available on a runner.
- **Host rules.** Each runner has its own allow and deny host lists (same patterns as `PROXY_ALLOW_HOSTS`:
  names, `*.example.com`, IPs, CIDR). The runner also honours its local `PROXY_ALLOW_HOSTS`, `PROXY_DENY_HOSTS`
  and `PROXY_ALLOW_SOCKETS`. Deny rules from both sides always apply; the server-side allow list wins when it is
  set, otherwise the local one is used.
- **Tokens.** A token only works for the runner API (`/api/runner-agent/*`); it cannot read or change anything
  else. Revoke a runner to cut it off immediately.

## Limits

Up to 25 active runners per workspace. Runner jobs are kept for 7 days; sample history follows the monitor
retention setting. Variables set by scripts do not persist between checks.
