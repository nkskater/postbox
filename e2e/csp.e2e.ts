import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser } from "playwright-core";
import { launch, openApp } from "./helpers";

/** LAB-277: the app works under its enforced Content-Security-Policy. */
const baseUrl = inject("baseUrl");
const targetUrl = inject("targetUrl");
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

const post = async (path: string, body: unknown) =>
  (
    await fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();

describe("Content-Security-Policy (LAB-277)", () => {
  it("serves app pages with an enforced policy whose nonce is on every inline script", async () => {
    const res = await fetch(baseUrl + "/");
    const policy = res.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("frame-ancestors 'self'");
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
    expect(inline.length).toBeGreaterThan(0);
    for (const attrs of inline) expect(attrs).toContain(`nonce="${nonce}"`);
  });

  it("runs the theme pre-paint script under the policy", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|CSP violation/.test(m.text())) violations.push(m.text());
    });
    // Only the inline scripts run: the app itself would rewrite the saved appearance.
    await page.route("**/_next/static/**", (route) => route.abort());
    await page.goto(baseUrl);
    await page.evaluate(() =>
      localStorage.setItem(
        "postbox-appearance",
        JSON.stringify({ theme: "light", vars: {}, attrs: ["data-csp-check"] }),
      ),
    );
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-csp-check"))).toBe(true);
    expect(violations).toEqual([]);
    await context.close();
  });

  it("runs editors, the response preview and the visualizer without violations", async () => {
    const workspaceId = ((await (await fetch(`${baseUrl}/api/workspaces`)).json()) as { id: string }[])[0].id;
    const folder = (await post("/api/folders", { workspaceId, parentId: null, name: "CSP checks" })) as {
      id: string;
    };
    await post("/api/requests", {
      workspaceId,
      folderId: folder.id,
      request: {
        name: "Visualized",
        method: "GET",
        url: `${targetUrl}/csp`,
        headers: [],
        params: [],
        auth: { type: "none" },
        body: { mode: "none" },
        testScript: 'pm.visualizer.set("<h1>{{title}}</h1>", { title: "Visualized under CSP" });',
      },
    });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByText("CSP checks", { exact: true }).first().click();
    await page.getByText("Visualized", { exact: true }).first().click();
    await page.getByTitle(/^Send/).click();
    await expect.poll(() => page.getByText('"url": "/csp"').count()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "preview", exact: true }).click();
    const preview = page.frameLocator('iframe[title="Response preview"]');
    await expect.poll(() => preview.getByText(/\/csp/).count()).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "Visualization" }).click();
    const visual = page.frameLocator('iframe[title="Response visualization"]');
    await expect.poll(() => visual.getByText("Visualized under CSP").count()).toBe(1);
    expect(errors).toEqual([]);
    await context.close();
  });
});
