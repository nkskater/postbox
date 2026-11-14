// Windows desktop smoke test: serves a folder on 127.0.0.1 (update manifests and the
// installer) and appends every requested path to requests.log in that folder, so the
// test can tell whether the app asked for an update.
//
// Usage: node scripts/desktop-update-server.mjs <folder> <port>
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [dir, port] = process.argv.slice(2);
if (!dir || !port) {
  console.error("usage: desktop-update-server.mjs <folder> <port>");
  process.exit(2);
}
const root = path.resolve(dir);
const requests = path.join(root, "requests.log");

http
  .createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(/^\/+/, "");
    fs.appendFileSync(requests, `${name}\n`);
    const file = path.join(root, name);
    if (!name || path.dirname(file) !== root || !fs.existsSync(file) || name === "requests.log") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": name.endsWith(".json") ? "application/json" : "application/octet-stream",
      "content-length": fs.statSync(file).size,
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`Serving ${root} on http://127.0.0.1:${port}/`));
