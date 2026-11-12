import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import type { Browser } from "playwright-core";
import { launch } from "./helpers";

const baseUrl = inject("baseUrl");
let browser: Browser;
let target: http.Server;
let relayUrl: string;
const received: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
  browser = await launch();
  target = http.createServer((req, res) => {
    received.push(req.headers);
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Set-Cookie": "postbox_session=attacker; Path=/; HttpOnly",
    });
    res.end(
      '<title>Captured HTML</title><script>document.title="escaped"; document.cookie="browser_injected=yes; Path=/";</script>',
    );
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const workspace = await fetch(`${baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Capture isolation" }),
  }).then((res) => res.json());
  const response = await fetch(`${baseUrl}/api/capture/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: workspace.id, name: "Browser isolation" }),
  });
  expect(response.status).toBe(201);
  const session = await response.json();
  relayUrl = `${baseUrl}/capture/${session.token}/http:/127.0.0.1:${(target.address() as AddressInfo).port}/html`;
});

afterAll(async () => {
  await browser?.close();
  if (target) await new Promise<void>((resolve) => target.close(() => resolve()));
});

it("refuses browser navigation without sending its session to the upstream", async () => {
  const context = await browser.newContext();
  try {
    await context.addCookies([
      { name: "postbox_session", value: "victim-session", url: baseUrl, httpOnly: true },
    ]);
    const before = received.length;
    const page = await context.newPage();
    const response = await page.goto(relayUrl);
    expect(response?.status()).toBe(403);
    expect(received).toHaveLength(before);
    expect(await page.title()).not.toBe("escaped");
  } finally {
    await context.close();
  }
});

it("keeps an API client's relayed HTML inert even when presented as a browser document", async () => {
  const context = await browser.newContext();
  try {
    await context.addCookies([
      { name: "postbox_session", value: "victim-session", url: baseUrl, httpOnly: true },
    ]);
    const response = await context.request.get(relayUrl);
    expect(response.status()).toBe(200);
    // Present the real relay response, including its security headers, to Chromium. This also
    // exercises sandbox protection independently of the navigation gate.
    const page = await context.newPage();
    await page.route(relayUrl, (route) => route.fulfill({ response }));
    await page.goto(relayUrl);
    expect(await page.title()).toBe("Captured HTML");
    expect(received.at(-1)?.cookie).toBeUndefined();
    expect(response.headers()["set-cookie"]).toBeUndefined();
    const cookies = await context.cookies(baseUrl);
    expect(cookies.find((cookie) => cookie.name === "postbox_session")?.value).toBe("victim-session");
    expect(cookies.some((cookie) => cookie.name === "browser_injected")).toBe(false);
  } finally {
    await context.close();
  }
});
