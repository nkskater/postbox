import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Locator, Page } from "playwright-core";
import { launch, openApp } from "./helpers";

const baseUrl = inject("baseUrl");
const targetUrl = inject("targetUrl");
let browser: Browser;
let model: http.Server;
let modelUrl = "";

const REPLY = [
  "## Why it failed\n\n",
  "The server answered **401** because the `Authorization` header is missing.\n\n",
  "```json\n",
  '{ "error": "unauthorized", "hint": "' + "send a token ".repeat(30) + '" }\n',
  "```\n\n",
  "1. Add the header\n   - use `{{token}}`\n2. Send again\n\n",
  "| Header | Value |\n| --- | --- |\n| Authorization | Bearer {{token}} |\n\n",
  'Ignore this: <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> ',
  "[click me](javascript:window.__xss=3)\n",
];

beforeAll(async () => {
  browser = await launch();
  // Streams the reply in slow chunks, like a local model.
  model = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of REPLY) {
        res.write(`data: ${JSON.stringify({ model: "stub", choices: [{ delta: { content: piece } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 250));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => model.close(r));
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
const workspaceId = async () =>
  ((await (await fetch(`${baseUrl}/api/workspaces`)).json()) as { id: string }[])[0].id;

async function expectFormatted(page: Page, reply: Locator, container: Locator) {
  await reply.locator("table").waitFor();
  await expect(reply.locator("h3", { hasText: "Why it failed" })).toBeTruthy();
  expect(await reply.locator("strong", { hasText: "401" }).count()).toBe(1);
  expect(await reply.locator("ol ul li").count()).toBe(1);
  const text = await reply.innerText();
  expect(text).not.toMatch(/##|\*\*|```/);
  // The long code line scrolls inside the block instead of widening the panel.
  const pre = reply.locator("pre").first();
  const [preBox, panelBox] = [await pre.boundingBox(), await container.boundingBox()];
  expect(preBox!.x + preBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
  expect(await pre.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // Injected markup is inert text and the javascript: link has no target.
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await reply.locator("img").count()).toBe(0);
  expect(await reply.locator('a[href^="javascript"]').count()).toBe(0);
  expect(text).toContain('<img src=x onerror="window.__xss=1">');
}

describe("assistant replies as Markdown", () => {
  it("formats a streamed reply in the request sidebar, progressively and safely", async () => {
    const ws = await workspaceId();
    const folder = await post("/api/folders", { workspaceId: ws, parentId: null, name: "MarkdownReplies" });
    await post("/api/requests", {
      workspaceId: ws,
      folderId: folder.id,
      request: { name: "Formatted reply", method: "GET", url: `${targetUrl}/md` },
    });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByText("MarkdownReplies", { exact: true }).first().click();
    await page.getByText("Formatted reply", { exact: true }).first().click();
    await page.getByTitle("Assistant for this request").click();
    const pane = page.getByRole("complementary", { name: "Request assistant" });
    await pane.getByLabel("Server URL").fill(modelUrl);
    await pane.getByLabel("Model", { exact: true }).fill("stub");
    await pane.getByLabel("Message to the assistant").fill("Explain what is going on");
    await pane.getByRole("button", { name: "Ask", exact: true }).click();

    // While streaming, the partial reply is already formatted (heading and code block).
    const streaming = pane.locator("article", { has: page.locator(".animate-spin") });
    await streaming.locator("pre").waitFor();
    expect(await streaming.locator("h3").count()).toBe(1);
    expect(await streaming.locator(".animate-spin").count()).toBe(1);

    const reply = pane.locator("article", { hasText: "Why it failed" }).last();
    await expect.poll(() => pane.locator(".animate-spin").count(), { timeout: 15_000 }).toBe(0);
    await expectFormatted(page, reply.locator("[data-markdown]"), pane);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("formats replies in the Assistant tab", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    const settings = page.getByRole("region", { name: "Assistant model settings" });
    await settings.getByPlaceholder("http://your-server:11434").fill(modelUrl);
    await settings.getByPlaceholder("Your server's model name").fill("stub");
    await page.getByPlaceholder(/Describe the request/).fill("Explain the 401");
    await page.getByRole("button", { name: "Ask assistant" }).click();
    const conversation = page.getByRole("region", { name: "Assistant conversation" });
    const reply = conversation.locator("[data-markdown]").last();
    await expect.poll(() => conversation.locator("table").count(), { timeout: 15_000 }).toBeGreaterThan(0);
    // The last chunk has arrived and the streamed answer has become the saved message.
    await expect.poll(() => reply.innerText(), { timeout: 15_000 }).toContain("click me");
    await expectFormatted(page, reply, conversation);
    expect(errors).toEqual([]);
    await context.close();
  });
});
