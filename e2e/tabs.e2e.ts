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
});
