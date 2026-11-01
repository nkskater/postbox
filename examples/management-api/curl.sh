#!/usr/bin/env bash
# Create a collection, add a request and run it. Requires curl and jq.
set -euo pipefail
: "${POSTBOX_URL:=http://localhost:3000}"
: "${POSTBOX_TOKEN:?Set POSTBOX_TOKEN to a pbx_ token from Settings}"
api() { # method path [json-body]
  curl -fsS -X "$1" "$POSTBOX_URL$2" -H "Authorization: Bearer $POSTBOX_TOKEN" \
    ${3:+-H "Content-Type: application/json" -d "$3"}
}

workspace=$(api POST /api/workspaces '{"name":"Smoke tests"}' | jq -r .id)
collection=$(api POST /api/folders "{\"workspaceId\":\"$workspace\",\"name\":\"Health\"}" | jq -r .id)
api POST /api/requests "{\"workspaceId\":\"$workspace\",\"folderId\":\"$collection\",\"request\":{\"name\":\"Ping\",\"method\":\"GET\",\"url\":\"$POSTBOX_URL/api/health\"}}" >/dev/null
# The run streams newline-delimited JSON; the last line is the "done" event.
api POST /api/runs "{\"workspaceId\":\"$workspace\",\"folderId\":\"$collection\"}" | tail -n 1 | jq .
