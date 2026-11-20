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

The assistant uses `POST /api/ai` with `assistant: true` (and `includeSecrets: true` when the request-tab assistant's **Send secret values** is on), workspace authorization,
an OpenAI-compatible model request body, and tools `propose_request` and
`propose_execution`. The proposal arguments are `name`, `method`, `url`, and optional
`description`, `body` (raw text) and `testScript`. This returns proposed actions
only; execution requires a separate authorized request to `/api/proxy`. Neither
model output nor prompt instructions can bypass that approval step. Providers
without tool support can still answer questions in text. Conversations are limited
to 40 messages and each prompt to 30,000 characters; start a new conversation when
needed. Stop cancels the current model request or approved execution.

## Assistant in a request tab

Click **Assistant** in a request tab's toolbar to open the assistant beside that request. It uses
the same provider settings as the sidebar assistant (shared for the session, never saved in the
browser) and keeps one conversation per tab; closing the tab clears it.

**What it sees.** Every message you send starts with the tab's request exactly as it is now,
including unsaved changes: name, description, method, URL, params, headers, authorization, body,
pre-request and post-response scripts, contract, settings (including protocol settings) and saved
examples. It also includes the variables in scope and, unless you turn off **Include last
response**, the last response's status, headers, body (the first 40,000 characters) and test
results. **Show what is sent** displays the exact context.

Credentials (auth fields, sensitive body fields) and secret variable values are replaced with
`********` unless you turn on **Send secret values**, which is meant for local models. With it on,
those values and workspace secrets reach the model; the model's own API key is still never sent in
the conversation.

**What it can do.** The model proposes actions, and each one waits for you:

- **Proposed changes to this request** (`propose_request_edit`): any of the fields above. Each
  changed field shows a line diff. **Apply** applies every change, **Apply selected** applies the
  ticked fields, **Reject** changes nothing. Applied changes are ordinary unsaved edits in the tab;
  **Undo** on the proposal restores the previous values. Changes are validated with the same
  request schema the editor saves with, settings merge into the current settings, and a value the
  model only saw as `********` keeps its real value. If you edited a field after the proposal was
  made, the field is marked and **Apply** asks for a second click before replacing your change.
- **Send** (`propose_send`) sends the request as it is in the tab, with its scripts and tests, like
  the Send button.
- **Save** (`propose_save`) saves the request (or asks where to save a new one).
- **New request draft** (`propose_request`) opens a separate draft, as in the sidebar assistant.

The next message's context is the updated request, and the model is told which proposals you
applied, rejected or undid. Applying a change never runs a script or sends the request by itself.
The panel and `/api/ai` are not available while **AI assistant and AI requests** is switched off
under Settings → Features.
