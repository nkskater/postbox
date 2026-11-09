# In-app assistant

Open **Assistant** in the sidebar. Choose Strata, Ollama, or another
OpenAI-compatible server, enter its server URL and model name, and optionally
enter an API key. Postbox makes model requests from the server, so the hostname
must be reachable from the Postbox host or container. For example,
`http://ollama:11434` becomes `/v1/chat/completions`; a full completion endpoint
or an existing `/v1` prefix is also supported. Strata uses the same protocol.

Ask for help designing requests, writing tests, or explaining failures. Include
only the context you want to share. The assistant does not automatically collect
workspace requests or response bodies. Known workspace secrets and the model key
are redacted from the conversation before sending; workspace variable references
remain literal. Credentials and conversation remain in the open tab and are not
saved in browser storage. Closing the tab clears them.

A model with tool support can propose request drafts or executions. Every proposal
shows the complete URL, body, description, and tests for review. Approving a draft
opens a new editable request; use the normal request editor to save it. Approving
execution sends the displayed request and runs its tests through the existing
workspace execution permissions and network policy. Rejecting a proposal performs
no action. Unsupported or malformed tool calls cannot be approved. Execution
results are shown locally and are not automatically returned to the model.

The assistant uses `POST /api/ai` with `assistant: true`, workspace authorization,
an OpenAI-compatible model request body, and tools `propose_request` and
`propose_execution`. The proposal arguments are `name`, `method`, `url`, and optional
`description`, `body` (raw text) and `testScript`. This returns proposed actions
only; execution requires a separate authorized request to `/api/proxy`. Neither
model output nor prompt instructions can bypass that approval step. Providers
without tool support can still answer questions in text. Conversations are limited
to 40 messages and each prompt to 30,000 characters; start a new conversation when
needed. Stop cancels the current model request or approved execution.
