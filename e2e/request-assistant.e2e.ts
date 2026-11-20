import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright-core";
import { launch, openApp } from "./helpers";

const baseUrl = inject("baseUrl");
const targetUrl = inject("targetUrl");
let browser: Browser;
let model: http.Server;
let modelUrl = "";
/** Every request the stub model received, as JSON. */
const received: Record<string, unknown>[] = [];

const edit = {
  summary: "Add tracing, an API key, a JSON body, a timeout and a status test",
  changes: {
    method: "POST",
    headers: [
      { key: "Accept", value: "application/json", enabled: true },
      { key: "X-Trace", value: "{{traceId}}", enabled: true },
    ],
    auth: { type: "apikey", apikey: { key: "X-Api-Key", value: "{{apiKey}}", in: "header" } },
    body: { mode: "raw", language: "json", raw: '{"name":"Ada"}' },
    testScript: 'pm.test("status is 200", () => pm.response.to.have.status(200));',
    settings: { timeoutMs: 4321 },
  },
};

beforeAll(async () => {
  browser = await launch();
  model = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      // The first turn proposes an edit; later turns answer in text.
      const first = received.length === 1;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "stub",
          choices: [
            {
              message: first
                ? {
                    content: "Here is the change.",
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: { name: "propose_request_edit", arguments: JSON.stringify(edit) },
                      },
                    ],
                  }
                : { content: "The header is in place now." },
              finish_reason: first ? "tool_calls" : "stop",
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: { "features.assistant": null } }),
  });
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
const lastUserMessage = (request: Record<string, unknown>) => {
  const messages = request.messages as { role: string; content: string }[];
  return messages.filter((m) => m.role === "user").at(-1)!.content;
};

describe("request-tab assistant", () => {
  it("sees the request and response, applies an approved multi-tab edit, iterates and undoes", async () => {
    const ws = await workspaceId();
    const folder = await post("/api/folders", { workspaceId: ws, parentId: null, name: "AssistantRequests" });
    await post("/api/requests", {
      workspaceId: ws,
      folderId: folder.id,
      request: {
        name: "Assisted request",
        method: "GET",
        url: `${targetUrl}/assisted`,
        headers: [{ key: "Accept", value: "application/json", enabled: true }],
        auth: { type: "bearer", bearer: { token: "e2e-real-token-4242" } },
      },
    });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByText("AssistantRequests", { exact: true }).first().click();
    await page.getByText("Assisted request", { exact: true }).first().click();
    // Send once so the response is part of the context.
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("200").first().waitFor();

    await page.getByTitle("Assistant for this request").click();
    const pane = page.getByRole("complementary", { name: "Request assistant" });
    await pane.getByLabel("Server URL").fill(modelUrl);
    await pane.getByLabel("Model", { exact: true }).fill("stub");
    await pane.getByLabel("Message to the assistant").fill("Add a trace header and a status test");
    await pane.getByRole("button", { name: "Ask", exact: true }).click();

    const card = pane.getByRole("region", { name: "Proposed changes to this request" });
    await card.waitFor();
    for (const field of ["method", "headers", "auth", "body", "testScript", "settings"])
      await card.locator(`[data-field="${field}"]`).waitFor();

    // What the model received: the request (with unsaved state) and the last response, no credential.
    const first = lastUserMessage(received[0]);
    expect(first).toContain(`${targetUrl}/assisted`);
    expect(first).toContain("Last response: 200");
    expect(JSON.stringify(received[0])).not.toContain("e2e-real-token-4242");

    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await card.getByText("Applied").waitFor();
    // The tab now holds the edit as unsaved changes; the panel shows the tab's current request.
    await pane.getByRole("button", { name: "Show what is sent" }).click();
    const sent = pane.getByTestId("assistant-context");
    await expect.poll(() => sent.innerText()).toContain("X-Trace");
    expect(await sent.innerText()).toContain('"timeoutMs": 4321');

    await pane.getByLabel("Message to the assistant").fill("Is the header there?");
    await pane.getByRole("button", { name: "Ask", exact: true }).click();
    await pane.getByText("The header is in place now.").waitFor();
    const second = received[1];
    expect(lastUserMessage(second)).toContain("X-Trace");
    expect(lastUserMessage(second)).toContain('"timeoutMs": 4321');
    const tool = (second.messages as { role: string; content: string; tool_call_id?: string }[]).find(
      (m) => m.role === "tool",
    );
    expect(tool?.content).toContain("Applied by the user");

    await card.getByRole("button", { name: /Undo/ }).click();
    await card.getByText("Undone").waitFor();
    await expect.poll(() => sent.innerText()).not.toContain("X-Trace");

    expect(errors).toEqual([]);
    await context.close();
  });

  it("is hidden while the assistant feature is switched off", async () => {
    await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: { "features.assistant": false } }),
    });
    const { page, context } = await openApp(browser, baseUrl);
    await page.getByText("AssistantRequests", { exact: true }).first().click();
    await page.getByText("Assisted request", { exact: true }).first().click();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    expect(await page.getByTitle("Assistant for this request").count()).toBe(0);
    expect((await fetch(`${baseUrl}/api/ai`, { method: "POST", body: "{}" })).status).toBe(404);
    await context.close();
  });
});
