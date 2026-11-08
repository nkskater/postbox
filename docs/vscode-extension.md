# Postbox for VS Code

The extension in `extensions/vscode` lets you work with Postbox from the editor:

- **Browse** workspaces, collections, folders, requests and environments in the Postbox side bar.
- **Edit** a request or environment as JSON. Saving writes it back to the server (server mode) or to the file
  (offline mode).
- **Send** a request (play button, `Postbox: Send Request`, or the button on a `*.request.json` editor). The
  response, test results and console output open beside the editor, and the status bar shows the outcome. In
  server mode the request in the editor is sent as you see it, including unsaved edits.
- **Environments**: `Postbox: Select Environment` chooses the one used when sending.
- **`.env` import and export** with explicit secret controls (below).

## Server mode

1. Set `postbox.serverUrl` (`Postbox: Set Server URL`). Use `https://` for anything that is not localhost.
2. Create a personal API token on your Postbox profile page and run `Postbox: Set API Token`. It is kept in VS
   Code's secret storage, never in settings or files, and sent as `Authorization: Bearer ...`. Leave it empty
   to clear it.

Requests run on the server exactly as they do in the web app (variables, auth, cookies, scripts, history), so
what you see in the editor matches the app. Everything the token's account may not see or change is refused by
the server as usual.

## Offline mode

Set `postbox.mode` to `offline` (`Postbox: Switch Between Server and Offline`). The extension then looks in the
open folder for repository directories (see [repository-format.md](repository-format.md)): any directory with a
`collection.json` is a collection and any with an `environment.json` is an environment. Create them with
`postbox collection pull` / `postbox env pull`, or from a Git checkout.

- The side bar lists them; requests open as their real `*.request.json` files, so saving, diffing and Git work
  normally.
- Sending runs the request in the extension with the Postbox engine, including pre-request and test scripts.
  Nothing is sent to a Postbox server.
- Secret values are blank in repository files by design. In offline mode the extension reads them from your
  project's `.env` (`postbox.dotenvPath`) when you send: `apiKey=...` in `.env` supplies the variable `apiKey`.
  They are used for the request and never written back or shown in the result.
- `postbox.allowHosts` / `postbox.denyHosts` restrict what offline requests may call (same patterns as
  `PROXY_ALLOW_HOSTS`).

## `.env` and secrets

- **Import** (`Postbox: Import .env Into Environment`): choose which variables to bring in. Names that look like
  credentials (`token`, `secret`, `password`, `api_key`, ...) are marked. By default they are created as secret
  variables **without** their values; you can opt in to importing the values, which are then stored in Postbox
  as secrets. Existing variables are never removed and are not overwritten by the import.
- **Export** (`Postbox: Export Environment to .env`): writes enabled variables. Secret values and
  credential-looking names are left out unless you choose "Include secrets" in the confirmation. The file is
  created readable by you only; keep it out of Git (`.env` is in this repository's `.gitignore`).
- The extension never writes secrets to settings, the workspace state, the output channel or the result
  document, and the token lives only in secret storage.

## Trust

In an untrusted workspace the extension is limited: `postbox.serverUrl`, `postbox.dotenvPath` and `postbox.mode`
cannot be set by the workspace, so a repository you just opened cannot point the extension, with your token, at
another server or make it read another file.

## Build and test

```sh
npm run build:vscode            # extensions/vscode/dist/extension.js (+ the QuickJS runtime offline mode needs)
npx @vscode/vsce package --no-dependencies   # optional: build the .vsix from extensions/vscode
```

The logic lives in `extensions/vscode/src/bridge` and has no VS Code imports; `tests/vscode-bridge.test.ts` covers
it, and `tests/vscode-extension.test.ts` drives the real extension code against a small fake of the VS Code API
(`tests/helpers/fake-vscode.ts`). Press F5 in `extensions/vscode` with the built bundle to try it in an Extension
Development Host.
