#!/usr/bin/env node
/**
 * Regenerates the README screenshots in docs/screenshots/.
 *
 * 1. Start Postbox against a throwaway database, e.g.
 *      DATABASE_PATH=/tmp/postbox-shots.db npm run dev
 * 2. Run:
 *      npm run screenshots                       # uses http://localhost:3000
 *      BASE_URL=http://localhost:3124 CHROMIUM_PATH=/path/to/chrome npm run screenshots
 *
 * The script imports the demo collection, environment and CSV from docs/demo/ through the
 * REST API, then drives the UI with Playwright. The demo requests call
 * https://jsonplaceholder.typicode.com, so network access is required.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const DEMO = path.join(ROOT, "docs", "demo");
const VIEWPORT = { width: 1440, height: 860 };
let sessionCookie = "";

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function seed() {
  const [workspace] = await api("GET", "/api/workspaces");
  const tree = await api("GET", `/api/workspaces/${workspace.id}/tree`);
  if (tree.folders.some((f) => f.name === "JSONPlaceholder Demo")) {
    throw new Error(
      "The demo collection already exists. Use a fresh DATABASE_PATH so screenshots are reproducible.",
    );
  }
  for (const file of [
    "jsonplaceholder.postman_collection.json",
    "jsonplaceholder.postman_environment.json",
  ]) {
    await api("POST", "/api/import", {
      workspaceId: workspace.id,
      content: fs.readFileSync(path.join(DEMO, file), "utf8"),
    });
  }
  await api("PUT", "/api/variables", {
    workspaceId: workspace.id,
    scope: "global",
    ownerId: null,
    variables: [{ key: "appName", value: "Postbox", type: "default", enabled: true }],
  });
  // Start from default settings so the screenshots show the stock look.
  await api("POST", "/api/settings/import", { settings: { "tabs.previewOnClick": false } });
}

/** Uses a fresh throwaway instance, without external API traffic. */
async function usersScreenshots() {
  const status = await api("GET", "/api/auth/status");
  if (status.hasUsers) throw new Error("Users screenshots require a fresh throwaway account database.");
  const password = "demo-password-only";
  await api("POST", "/api/auth/setup", {
    username: "admin",
    displayName: "Workspace administrator",
    password,
  });
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  if (!login.ok) throw new Error("Screenshot administrator login failed");
  const value = /postbox_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  if (!value) throw new Error("Missing screenshot session");
  sessionCookie = `postbox_session=${value}`;
  await api("POST", "/api/admin/users", { username: "alex", displayName: "Alex Chen", password });
  await api("POST", "/api/admin/users", { username: "sam", displayName: "Sam Rivera", password });
  const workspace = await api("POST", "/api/workspaces", { name: "Platform APIs" });
  for (const [username, role] of [
    ["alex", "editor"],
    ["sam", "viewer"],
  ])
    await api("PUT", `/api/workspaces/${workspace.id}/members`, { username, role });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addCookies([{ name: "postbox_session", value, url: BASE }]);
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator("header").getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Platform APIs", exact: true }).click();
    await page.getByTitle("Settings (Ctrl+,)", { exact: true }).click();
    await page.getByRole("button", { name: "Workspace sharing", exact: true }).click();
    await page.getByLabel("Role for alex", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Create invite link", exact: true }).click();
    await page.getByLabel("Invite link", { exact: true }).waitFor();
    // Documentation uses an illustrative link, never the disposable database's live token.
    await page.getByLabel("Invite link", { exact: true }).evaluate((input) => {
      input.value = "https://postbox.example/invite?token=example-single-use-invitation-token";
    });
    await page.screenshot({ path: path.join(OUT, "workspace-sharing.png"), fullPage: true });
    await page.getByRole("button", { name: "Users", exact: true }).click();
    await page.getByRole("button", { name: "Disable alex", exact: true }).waitFor();
    await page.screenshot({ path: path.join(OUT, "users.png"), fullPage: true });
    console.log("  ✓ workspace-sharing.png\n  ✓ users.png");
  } finally {
    await browser.close();
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (process.env.SCREENSHOT_SET === "users") return usersScreenshots();
  await seed();

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20_000);
  const shot = async (name, opts = {}) => {
    await page.waitForTimeout(350); // let animations settle
    await page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
    console.log(`  ✓ ${name}.png`);
  };
  // The sidebar comes first in the DOM, so the first exact text match is the sidebar row.
  const openRequest = async (name) => {
    await page.getByText(name, { exact: true }).first().dblclick();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  };
  const send = async () => {
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page
      .getByText(/^Status:/)
      .first()
      .waitFor();
    await page.waitForTimeout(300);
  };

  // Hide the Next.js dev badge and transient toasts so they don't end up in the images.
  const hideOverlays = () =>
    page.addStyleTag({ content: "nextjs-portal, [data-sonner-toaster] { display: none !important; }" });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await hideOverlays();

  // Select the demo environment.
  await page.getByRole("combobox").filter({ hasText: "No environment" }).click();
  await page.getByRole("option", { name: "JSONPlaceholder" }).click();

  // Expand the collection and its folders.
  await page.getByText("JSONPlaceholder Demo", { exact: true }).click();
  await page.getByText("Users", { exact: true }).click();
  await page.getByText("Posts", { exact: true }).click();

  // 1. Main view: request with response.
  await openRequest("Get user");
  await send();
  await shot("request-response");

  // 2. Test results tab.
  await page.getByRole("tab", { name: /Test Results/ }).click();
  await shot("test-results");

  // 3. Timing breakdown popover.
  await page.getByRole("tab", { name: "Body", exact: true }).last().click(); // response panel
  await page.getByText(/^Time:/).click();
  await shot("timing");
  await page.keyboard.press("Escape");

  // 4. Post-response script with snippets.
  await page.getByRole("tab", { name: /Post-response Script/ }).click();
  await shot("scripts");

  // 5. JSON body request.
  await openRequest("Create post");
  await page.getByRole("tab", { name: /^Body/ }).first().click();
  await send();
  await shot("request-body");

  // 6. Code snippet generator.
  await page.getByRole("button", { name: "Code" }).click();
  await page.getByRole("dialog").getByRole("combobox").click();
  await page.getByRole("option", { name: /Python/ }).click();
  await page.waitForTimeout(600);
  await shot("code-snippet");
  await page.keyboard.press("Escape");

  // 7. Variable highlighting and hover tooltip.
  await page.keyboard.press("Alt+t");
  await page.locator(".cm-content").first().click();
  await page.keyboard.type("{{baseUrl}}/users/{{userId}}?fields={{missingVariable}}");
  await page.getByText("{{baseUrl}}").first().hover();
  await page.waitForTimeout(700);
  await shot("variables");

  // 8. Console panel after some requests.
  await page.keyboard.press("Control+`");
  await shot("console");
  await page.keyboard.press("Control+`");

  // 9. Environment editor with a masked secret.
  await page.getByRole("button", { name: "Environments" }).click();
  await page.locator("div.cursor-pointer", { hasText: "JSONPlaceholder" }).first().click();
  await page.locator('input[value="baseUrl"]').waitFor();
  await shot("environment");
  await page.getByRole("button", { name: "Collections" }).click();

  // 10. Collection settings: inherited auth.
  await page.getByRole("button", { name: /Actions for collection JSONPlaceholder Demo/ }).click();
  await page.getByRole("menuitem", { name: /Edit collection/ }).click();
  await page.getByRole("tab", { name: "Authorization" }).click();
  await shot("collection-auth");

  // 11. Collection runner: iteration data grid, then results.
  await page.getByRole("button", { name: /Run collection JSONPlaceholder Demo/ }).click();
  await page.setInputFiles("input[type=file][accept*=csv]", path.join(DEMO, "users.csv"));
  await page.getByRole("button", { name: "Trim" }).waitFor();
  await shot("runner-data");
  await page.getByRole("button", { name: "Trim" }).click();
  await page.getByRole("button", { name: "Dedupe" }).click();
  await page.getByRole("button", { name: /^Run JSONPlaceholder Demo/ }).click();
  await page.getByRole("button", { name: /Export JUnit/ }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /^failed \(/i }).click();
  await page.locator("button", { hasText: "Get user" }).first().click();
  await shot("runner-results");

  // 12. Import dialog with a cURL command.
  await page.getByRole("button", { name: "Import", exact: true }).first().click();
  await page.getByRole("tab", { name: /Raw text/ }).click();
  await page
    .getByRole("dialog")
    .locator("textarea")
    .fill(
      'curl -X POST \'https://jsonplaceholder.typicode.com/posts\' \\\n  -H \'Content-Type: application/json\' \\\n  --data-raw \'{"title":"foo","body":"bar","userId":1}\'',
    );
  await shot("import");
  await page.keyboard.press("Escape");

  // 13. Command palette.
  await page.keyboard.press("Control+k");
  await page.keyboard.type("user");
  await shot("command-palette");
  await page.keyboard.press("Escape");

  // 14. Settings: appearance with accent colors.
  await page.keyboard.press("Control+,");
  await page.getByRole("radio", { name: "Violet" }).click();
  await shot("settings");

  // 15. Light theme with a different accent, on the request view.
  await api("PATCH", "/api/settings", {
    values: { "appearance.theme": "light", "appearance.accent": "teal" },
  });
  await page.reload({ waitUntil: "networkidle" });
  await hideOverlays();
  await page.getByText("Get user", { exact: true }).first().click();
  await send();
  await shot("light-theme");

  // Leave the demo instance on default settings.
  await api("POST", "/api/settings/import", { settings: {} });
  await browser.close();
  console.log(`Screenshots written to ${path.relative(ROOT, OUT)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
