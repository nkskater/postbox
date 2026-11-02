# AI model requests

Send a prompt to a language model and inspect what comes back: streamed text, reasoning, tool calls and
token usage. A model request is an ordinary Postbox request whose body mode is **AI model**, so it
lives in collections, uses environments and variables, inherits folder headers and authorization, and
works with history, examples, code snippets and the REST API.

## Making one

1. Create a request and set the method to POST and the URL to the model endpoint.
2. In **Body**, choose **AI model**.
3. Pick the **provider format**:
   - **OpenAI-compatible (chat completions)**: OpenAI, Azure OpenAI, and self-hosted servers that speak
     the same API: Ollama (`http://localhost:11434/v1/chat/completions`), vLLM, LM Studio, llama.cpp and
     others.
   - **Anthropic (messages)**: `https://api.anthropic.com/v1/messages`. Postbox adds the
     `anthropic-version` header unless you set your own.
4. Set the model, optional temperature, top P and maximum output tokens, a system prompt, and the
   conversation. Add **tools** (name, description, JSON Schema parameters) and a tool choice if you want
   the model to be able to call them. **Extra parameters** is a JSON object merged into the request for
   options a provider or self-hosted server adds; it cannot override `model`, `messages`, `stream`,
   `tools`, `tool_choice` or `system`.
5. Add the API key under **Authorization**: _Bearer token_ for OpenAI-compatible servers, or an _API key_
   in the header `x-api-key` for Anthropic. Store the key as a secret variable or a vault reference
   (`{{vault:name}}`), not in the request.
6. **Send**. The response pane streams the answer as it arrives.

Variables work in the model name, system prompt, messages, tool descriptions and extra parameters.

## The response pane

- **Answer** streams as text arrives; **Reasoning** appears separately when the provider returns it.
- **Tool calls** are listed with their name, id and pretty-printed arguments. Arguments the model got
  wrong (not valid JSON) are flagged rather than hidden.
- **Usage** (input, output and total tokens) is shown when the provider reports it. The finish reason,
  model name and elapsed time are shown in the header.
- **Raw events** shows every normalised event in order, for debugging a provider.
- A provider error is shown with its HTTP status and message.

## Tools are never run by Postbox

Postbox reports the tool calls a model makes and nothing more. To continue the conversation, type the
result of each call into its box and choose **Add results to the conversation**: the assistant turn and
your tool results are appended to the messages, and you send again. Nothing is executed on your behalf,
so there is no tool-execution permission to grant.

## Credentials

The key is applied by the server and masked in anything shown to the browser: a provider that echoes
the key in an error message does not reveal it. Requests go through the same outbound host policy as
every other request (blocked and private ranges, proxy settings, certificates). Failed requests are not
retried automatically, because a retry would be a second billed request.

## Automation

`POST /api/ai` takes `{ "workspaceId", "environmentId"?, "folderId"?, "request": { …, "body": { "mode": "ai", "ai": { … } } } }`
and returns newline-delimited JSON:

```
{"type":"open","status":200}
{"type":"text","text":"Hel"}
{"type":"tool_call","index":0,"id":"call_1","name":"get_weather","argumentsDelta":"{\"ci"}
{"type":"usage","usage":{"inputTokens":11,"outputTokens":7,"totalTokens":18}}
{"type":"done","status":200,"elapsedMs":812,"result":{"text":"…","toolCalls":[…],"usage":{…},"finishReason":"stop","model":"…","reasoning":"","error":null}}
```

or `{"type":"error","status":401,"message":"…"}`. It needs the same permission as sending a request.
Saved model requests also run through the existing `send_request` MCP tool, the collection runner and
monitors, which return the provider's raw JSON (set **Stream** off for a single JSON response).

## Supported formats

OpenAI-compatible chat completions and Anthropic messages are built in, including streaming, tool
calls and usage. Other providers are reachable through their OpenAI-compatible endpoints, or with a raw
JSON body.
