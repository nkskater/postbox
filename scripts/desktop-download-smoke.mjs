// Windows desktop smoke test: drives the Postbox Desktop window through the WebView2 DevTools port
// (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N) and checks that downloads from a
// server URL, a blob and a window.open export land in the download folder without overwriting each other.
//
// Usage: node scripts/desktop-download-smoke.mjs <devtools-port> <app-base-url> <download-dir> <environment-id>
import fs from "node:fs";
import path from "node:path";

const [port, base, dir, environmentId] = process.argv.slice(2);
if (!port || !base || !dir || !environmentId) {
  console.error(
    "usage: desktop-download-smoke.mjs <devtools-port> <app-base-url> <download-dir> <environment-id>",
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const value = await check().catch((error) => {
      last = String(error?.cause ?? error);
      return undefined;
    });
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}${last ? ` (last error: ${last})` : ""}`);
    await sleep(500);
  }
}

const pages = async () =>
  (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page");

const target = await until("the app window on the DevTools port", async () => {
  const list = await pages();
  const found = list.find((t) => t.url.startsWith(base));
  if (!found) throw new Error(`pages: ${JSON.stringify(list.map((t) => t.url))}`);
  return found;
});
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error("Could not connect to the app window"));
});
let nextId = 0;
const waiting = new Map();
socket.onmessage = (message) => {
  const reply = JSON.parse(message.data);
  waiting.get(reply.id)?.(reply);
  waiting.delete(reply.id);
};

function evaluate(expression) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    waiting.set(id, (reply) => {
      if (reply.error || reply.result?.exceptionDetails) reject(new Error(JSON.stringify(reply)));
      else resolve(reply.result.result?.value);
    });
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, userGesture: true, awaitPromise: true, returnByValue: true },
      }),
    );
  });
}

/** Clicks a temporary <a download> in the app page, as the app's own download buttons do. */
const clickDownload = (hrefExpression, name = "") =>
  evaluate(`(() => {
    const a = document.createElement("a");
    a.href = ${hrefExpression};
    a.download = ${JSON.stringify(name)};
    document.body.append(a);
    a.click();
    a.remove();
    return true;
  })()`);

const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const waitForFiles = (what, pattern, count) =>
  until(`${what} in ${dir} (have: ${files().join(", ") || "nothing"})`, async () => {
    const matches = files().filter((name) => pattern.test(name));
    // A finished download no longer has its temporary name and has content.
    return (
      matches.length >= count &&
      matches.every((name) => fs.statSync(path.join(dir, name)).size > 0) &&
      matches
    );
  });

await until("the app to finish loading", () => evaluate("document.readyState === 'complete'"));
const appUrl = await evaluate("location.href");

// 1. A server URL with Content-Disposition (Settings > Download backup), twice: the second gets " (1)".
await clickDownload(JSON.stringify("/api/backup?secrets=omit"));
await waitForFiles("the backup", /^postbox-backup-no-secrets-\d{4}-\d{2}-\d{2}\.json$/, 1);
await clickDownload(JSON.stringify("/api/backup?secrets=omit"));
const backups = await waitForFiles(
  "a second backup",
  /^postbox-backup-no-secrets-\d{4}-\d{2}-\d{2}( \(1\))?\.json$/,
  2,
);
if (!backups.some((name) => name.includes(" (1)")))
  throw new Error(`Second backup overwrote the first: ${backups}`);
for (const name of backups) JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

// 2. A blob URL (Save response, dataset and report exports).
await clickDownload(
  `URL.createObjectURL(new Blob(["desktop smoke"], { type: "text/plain" }))`,
  "desktop-smoke.txt",
);
const [blob] = await waitForFiles("the blob download", /^desktop-smoke\.txt$/, 1);
if (fs.readFileSync(path.join(dir, blob), "utf8") !== "desktop smoke")
  throw new Error("Blob download has wrong content");

// 3. window.open(..., "_blank") export (environment export) opens in-app and saves the attachment.
await evaluate(
  `window.open(${JSON.stringify(`/api/export/environment/${environmentId}`)}, "_blank") !== null`,
).then((opened) => {
  if (!opened) throw new Error("window.open was refused");
});
await waitForFiles("the environment export", /\.postman_environment\.json$/, 1);
// The pop-up that only carried the download closes itself.
await until(
  "the export pop-up to close",
  async () => !(await pages()).some((t) => t.url === "about:blank"),
  20_000,
);

// The app window itself never navigated away.
if ((await evaluate("location.href")) !== appUrl)
  throw new Error("The app window navigated during the downloads");
socket.close();
console.log(`Downloads OK: ${files().join(", ")}`);
