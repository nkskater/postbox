import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser } from "playwright-core";
import { launch, openApp, typeInEditor } from "./helpers";

const baseUrl = inject("baseUrl");
const targetUrl = inject("targetUrl");
const wsUrl = inject("wsUrl");
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
const workspaceId = async () =>
  ((await (await fetch(`${baseUrl}/api/workspaces`)).json()) as { id: string }[])[0].id;

/** A collection with one request that has a saved example, so a mock has something to serve. */
async function seedWithExample(name: string) {
  const ws = await workspaceId();
  const folder = await post("/api/folders", { workspaceId: ws, parentId: null, name });
  await post("/api/requests", {
    workspaceId: ws,
    folderId: folder.id,
    request: {
      name: "Get widget",
      method: "GET",
      url: `${targetUrl}/widgets/1`,
      examples: [
        {
          id: "ex1",
          name: "ok",
          status: 200,
          statusText: "OK",
          headers: [{ key: "content-type", value: "application/json", enabled: true }],
          body: '{"widget":"from-mock"}',
          createdAt: Date.now(),
        },
      ],
    },
  });
  return folder.id as string;
}

describe("mock servers", () => {
  it("creates a mock from the UI and serves a saved example", async () => {
    await seedWithExample("MockSource");
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Mocks", exact: true }).click();
    await page.getByRole("button", { name: "New mock" }).click();
    await page.getByLabel("Mock name").fill("Widget mock");
    await page.getByLabel("Mock collection").selectOption({ label: "MockSource" });
    await page.getByRole("button", { name: "Create mock" }).click();
    const endpoint = page.getByLabel("Mock endpoint");
    await endpoint.waitFor();
    const url = await endpoint.inputValue();
    expect(url).toMatch(/\/mock\/.+/);
    await page.getByLabel("New mock key").waitFor();
    const key = await page.getByLabel("New mock key").inputValue();
    const res = await fetch(`${url}/widgets/1`, {
      headers: { "x-postbox-mock-key": key },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("from-mock");
    // Without the key a private mock must refuse.
    const denied = await fetch(`${url}/widgets/1`);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("monitors", () => {
  it("creates a monitor, runs a check and shows its history", async () => {
    await seedWithExample("MonitorSource");
    const ws = await workspaceId();
    const folders = (await (await fetch(`${baseUrl}/api/workspaces/${ws}/tree`)).json()) as unknown;
    expect(JSON.stringify(folders)).toContain("MonitorSource");
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Monitors", exact: true }).click();
    await page.getByRole("button", { name: "New monitor" }).click();
    await page.getByLabel("Monitor name").fill("Widget monitor");
    await page.getByLabel("Monitor collection").selectOption({ label: "MonitorSource" });
    await page.getByRole("button", { name: "Save monitor" }).click();
    await page.getByText("Widget monitor", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Run check now" }).click();
    await expect
      .poll(
        async () => (await page.getByText(/passed|failed|healthy|No checks yet/i).allInnerTexts()).join("|"),
        {
          timeout: 30000,
        },
      )
      .not.toContain("No checks yet");
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("live protocols", () => {
  it("connects a WebSocket request, sends a message and shows the echo", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByTitle("New request (Alt+T)").click();
    await typeInEditor(page, "Enter URL", wsUrl);
    await page.getByTitle(/^Connect/).click();
    const box = page.getByPlaceholder(/Message \(Ctrl\+Enter to send\)/);
    await box.waitFor();
    await box.fill("hello socket");
    await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("echo:hello socket").waitFor({ timeout: 15000 });
    expect(errors).toEqual([]);
    await context.close();
  });
});
