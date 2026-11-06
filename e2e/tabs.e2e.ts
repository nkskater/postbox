import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { launch, openApp, typeInEditor } from "./helpers";

const baseUrl = inject("baseUrl");
const targetUrl = inject("targetUrl");
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

const api = async (path: string, body: unknown) =>
  (
    await fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
const workspaceId = async () =>
  ((await (await fetch(`${baseUrl}/api/workspaces`)).json()) as { id: string }[])[0].id;
const tabStrip = (page: Page) => page.locator("div.h-9.overflow-x-auto > div");

describe("switching between tabs keeps their state", () => {
  it("keeps unsaved collection edits", async () => {
    const ws = await workspaceId();
    await api("/api/folders", { workspaceId: ws, parentId: null, name: "TabsCollection" });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByText("TabsCollection", { exact: true }).first().hover();
    await page
      .getByRole("button", { name: /Actions for collection TabsCollection/ })
      .first()
      .click();
    await page.getByRole("menuitem", { name: /Edit collection/ }).click();
    const description = page.getByPlaceholder(/Describe this collection/);
    await description.fill("unsaved words");
    await page.getByTitle("New request (Alt+T)").click();
    await tabStrip(page).nth(0).click();
    await expect.poll(() => description.inputValue()).toBe("unsaved words");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("keeps unsaved environment edits", async () => {
    const ws = await workspaceId();
    await api("/api/environments", { workspaceId: ws, name: "TabsEnv", variables: [] });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Environments", exact: true }).click();
    await page.getByText("TabsEnv", { exact: true }).first().click();
    // Wait for the editor to finish loading so the server data cannot arrive after the edit.
    await expect
      .poll(() =>
        page
          .locator("input")
          .evaluateAll((els) => els.some((e) => (e as HTMLInputElement).value === "TabsEnv")),
      )
      .toBe(true);
    const add = page.getByPlaceholder("Add new variable");
    await add.fill("draft_var");
    await page.getByTitle("New request (Alt+T)").click();
    await tabStrip(page).nth(0).click();
    await expect.poll(() => page.getByPlaceholder("Name").first().inputValue()).toBe("draft_var");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("remembers which section of a request was open, plus its response", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByTitle("New request (Alt+T)").click();
    await typeInEditor(page, "Enter URL", `${targetUrl}/sections`);
    await page.getByRole("tab", { name: /^Headers/ }).click();
    await page.getByTitle(/^Send/).click();
    await expect.poll(() => page.getByText('"url": "/sections"').count()).toBeGreaterThan(0);
    await page.getByTitle("New request (Alt+T)").click();
    await tabStrip(page).nth(0).click();
    await expect
      .poll(() =>
        page
          .getByRole("tab", { name: /^Headers/ })
          .first()
          .getAttribute("data-state"),
      )
      .toBe("active");
    expect(await page.getByText('"url": "/sections"').count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("shows unsaved indicator and confirms before closing dirty collection tab", async () => {
    const ws = await workspaceId();
    await api("/api/folders", { workspaceId: ws, parentId: null, name: "UnsavedCol" });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByText("UnsavedCol", { exact: true }).first().hover();
    await page
      .getByRole("button", { name: /Actions for collection UnsavedCol/ })
      .first()
      .click();
    await page.getByRole("menuitem", { name: /Edit collection/ }).click();
    const tab = tabStrip(page).first();
    const desc = page.getByPlaceholder(/Describe this collection/);
    await desc.fill("pending change");
    // Verify unsaved indicator dot is present
    await expect.poll(() => tab.locator("span.bg-primary").count()).toBeGreaterThan(0);
    // Attempt to close tab
    await tab.getByRole("button", { name: "Close tab" }).click();
    await expect
      .poll(() => page.getByText(/Discard unsaved changes to "UnsavedCol"\?/).count())
      .toBeGreaterThan(0);
    // Cancel close: tab stays open with content preserved
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => page.getByText(/Discard unsaved changes/).count()).toBe(0);
    await expect.poll(() => tab.count()).toBeGreaterThan(0);
    expect(await desc.inputValue()).toBe("pending change");
    // Discard and close: tab closes
    await tab.getByRole("button", { name: "Close tab" }).click();
    await page.getByRole("button", { name: "Discard and close" }).click();
    await expect.poll(() => tabStrip(page).locator("text=UnsavedCol").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("shows unsaved indicator and confirms before closing dirty environment tab", async () => {
    const ws = await workspaceId();
    await api("/api/environments", { workspaceId: ws, name: "UnsavedEnv", variables: [] });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Environments", exact: true }).click();
    await page.getByText("UnsavedEnv", { exact: true }).first().click();
    await expect
      .poll(() =>
        page
          .locator("input")
          .evaluateAll((els) => els.some((e) => (e as HTMLInputElement).value === "UnsavedEnv")),
      )
      .toBe(true);
    const tab = tabStrip(page).first();
    const add = page.getByPlaceholder("Add new variable");
    await add.fill("temp_token");
    await expect.poll(() => tab.locator("span.bg-primary").count()).toBeGreaterThan(0);
    await tab.getByRole("button", { name: "Close tab" }).click();
    await expect
      .poll(() => page.getByText(/Discard unsaved changes to "UnsavedEnv"\?/).count())
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "Discard and close" }).click();
    await expect.poll(() => tabStrip(page).locator("text=UnsavedEnv").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("response viewer audit", () => {
  it("displays pretty, raw, preview, headers, cookies, test results and handles search and copy", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    // 1. JSON request with test script and cookies
    await page.getByTitle("New request (Alt+T)").click();
    await typeInEditor(page, "Enter URL", `${targetUrl}/cookies`);
    await page.getByRole("tab", { name: /Post-response/ }).click();
    await page.getByRole("button", { name: "Status code is 200" }).click();
    await page.getByTitle(/^Send/).click();

    // Verify body & search panel
    await expect.poll(() => page.getByText("cookieSet").count(), { timeout: 10000 }).toBeGreaterThan(0);
    const searchBtn = page.getByTitle("Search (Ctrl+F)");
    await expect.poll(() => searchBtn.count(), { timeout: 10000 }).toBeGreaterThan(0);
    await searchBtn.click();
    await expect.poll(() => page.locator(".cm-search").count(), { timeout: 10000 }).toBeGreaterThan(0);

    // Toggle raw and pretty views
    await page.getByRole("button", { name: "raw", exact: true }).click();
    await page.getByRole("button", { name: "pretty", exact: true }).click();

    // Check Cookies tab
    await page.getByRole("tab", { name: /^Cookies/ }).click();
    await expect.poll(() => page.getByText("session").count(), { timeout: 10000 }).toBeGreaterThan(0);
    await expect.poll(() => page.getByText("token123").count(), { timeout: 10000 }).toBeGreaterThan(0);

    // Check Headers tab in response viewer
    await page.getByRole("tab", { name: /^Headers \(/ }).click();
    await expect.poll(() => page.getByText("content-type").count(), { timeout: 10000 }).toBeGreaterThan(0);

    // Check Test Results tab
    await page.getByRole("tab", { name: /^Test Results/ }).click();
    await expect
      .poll(() => page.getByText("Status code is 200").count(), { timeout: 10000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.getByText("pass", { exact: true }).count(), { timeout: 10000 })
      .toBeGreaterThan(0);

    // 2. HTML preview audit
    await page.getByTitle("New request (Alt+T)").click();
    await typeInEditor(page, "Enter URL", `${targetUrl}/html`);
    await page.getByTitle(/^Send/).click();
    await page.getByRole("button", { name: "preview", exact: true }).click();
    const previewFrame = page.frameLocator('iframe[title="Response preview"]');
    await expect
      .poll(() => previewFrame.locator("h1").textContent(), { timeout: 10000 })
      .toContain("Preview Header");

    // 3. Binary response audit
    await page.getByTitle("New request (Alt+T)").click();
    await typeInEditor(page, "Enter URL", `${targetUrl}/image`);
    await page.getByTitle(/^Send/).click();
    await expect.poll(() => page.getByText("BINARY").count(), { timeout: 10000 }).toBeGreaterThan(0);
    await page.getByRole("button", { name: "preview", exact: true }).click();
    await expect
      .poll(() => page.locator('iframe[title="Image response preview"]').count(), { timeout: 10000 })
      .toBeGreaterThan(0);
    await page.getByTitle("Copy").click();
    await expect
      .poll(() => page.getByText("Copied base64 to clipboard").count(), { timeout: 10000 })
      .toBeGreaterThan(0);

    expect(errors).toEqual([]);
    await context.close();
  });
});
