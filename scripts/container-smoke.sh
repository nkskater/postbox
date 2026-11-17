#!/usr/bin/env bash
# Smoke test for the Docker image: starts it on a temporary volume with authentication on and checks
# that it becomes healthy by its own HEALTHCHECK, executes a request with a test script (which needs
# the bundled QuickJS WASM file), ships a working CLI, runs as UID 1001 with its database in /data,
# and keeps its data across a restart. Usage: scripts/container-smoke.sh [image] (default postbox:smoke).
set -euo pipefail

image="${1:-postbox:smoke}"
name="postbox-smoke"
volume="postbox-smoke-data"
port="${SMOKE_PORT:-3000}"
base="http://127.0.0.1:${port}"
token="smoke-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker logs "$name" 2>&1 | tail -n 100 || true; fi
  docker rm -fv "$name" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

start() {
  # The image's own HEALTHCHECK command; only its interval is shortened so the wait is seconds.
  docker run --detach --name "$name" --volume "$volume:/data" --publish "127.0.0.1:${port}:3000" \
    --env POSTBOX_TOKEN="$token" --health-interval 2s "$image" >/dev/null
  for _ in $(seq 1 60); do
    health=$(docker inspect --format '{{.State.Health.Status}}' "$name")
    case "$health" in
      healthy) echo "Container is healthy"; return 0 ;;
      unhealthy) fail "container reported unhealthy" ;;
    esac
    [ "$(docker inspect --format '{{.State.Running}}' "$name")" = true ] || fail "container exited"
    sleep 2
  done
  fail "container did not become healthy within 120 s"
}

api() { # method path [json-body]
  curl --fail-with-body --silent --show-error --max-time 30 -X "$1" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    ${3:+--data "$3"} "$base$2"
}

docker rm -fv "$name" >/dev/null 2>&1 || true
docker volume rm -f "$volume" >/dev/null 2>&1 || true
start

curl --fail --silent --show-error --max-time 5 "$base/api/health" | jq -e '.status == "ok"' >/dev/null ||
  fail "/api/health did not report ok"
code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$base/api/workspaces")
[ "$code" = 401 ] || fail "unauthenticated API call returned $code, expected 401"
echo "Health check ok; API requires the token"

POSTBOX_TOKEN="$token" node scripts/check-cold-route.mjs "$base"

workspace=$(api GET /api/workspaces | jq -er '.[0].id')
request=$(jq -n --arg ws "$workspace" '{
  workspaceId: $ws,
  request: {
    method: "GET",
    url: "http://127.0.0.1:3000/api/health",
    testScript: "pm.test(\"health is ok\", () => pm.expect(pm.response.json().status).to.equal(\"ok\"));"
  }
}')
result=$(api POST /api/proxy "$request")
echo "$result" | jq -e '.response.status == 200' >/dev/null || fail "proxied request failed: $result"
echo "$result" | jq -e '.tests | length == 1 and all(.passed)' >/dev/null ||
  fail "test script did not pass: $(echo "$result" | jq -c '{tests, scriptErrors}')"
echo "Request with a test script ran in the container"

docker exec "$name" postbox-cli --version >/dev/null || fail "postbox-cli --version failed"
uid=$(docker exec "$name" sh -c 'stat -c %u /proc/1')
[ "$uid" = 1001 ] || fail "server runs as UID $uid, expected 1001"
docker exec "$name" test -s /data/postbox.db || fail "/data/postbox.db was not created"
owner=$(docker exec "$name" stat -c %u /data/postbox.db)
[ "$owner" = 1001 ] || fail "/data/postbox.db is owned by UID $owner, expected 1001"
echo "CLI works; server runs as UID 1001 with its database in /data"

marker="smoke-$(date +%s)"
api POST /api/workspaces "$(jq -n --arg n "$marker" '{name: $n}')" >/dev/null
docker restart "$name" >/dev/null
for _ in $(seq 1 60); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$name")" = healthy ] && break
  sleep 2
done
[ "$(docker inspect --format '{{.State.Health.Status}}' "$name")" = healthy ] ||
  fail "container did not become healthy after restart"
api GET /api/workspaces | jq -e --arg n "$marker" 'any(.[]; .name == $n)' >/dev/null ||
  fail "workspace created before the restart is missing"
echo "Data survived a restart on the same volume"

echo "Container smoke test passed"
