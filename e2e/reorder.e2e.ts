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

const tabs = (page: Page) => page.locator("[data-tab-id]");
const titles = async (page: Page) => (await tabs(page).allInnerTexts()).map((t) => t.trim());

async function threeTabs(page: Page) {
  for (const name of ["one", "two", "three"]) {
    await page.getByTitle("New request (Alt+T)").click();
    await typeInEditor(page, "Enter URL", `${targetUrl}/${name}`);
  }
  await expect.poll(() => tabs(page).count()).toBe(3);
}

describe("rearranging tabs", () => {
  it("drags a tab to a new position and keeps its unsaved edits and the active tab", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await threeTabs(page);
    const ids = await tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id")));
    // Third tab is active. Drag the first tab onto the last position.
    await tabs(page).nth(0).dragTo(tabs(page).nth(2));
    await expect
      .poll(() => tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id"))))
      .toEqual([ids[1], ids[2], ids[0]]);
    // The previously active tab (ids[2]) is still the active one: its URL is shown.
    await expect.poll(() => page.locator(".cm-content").first().innerText()).toContain("/three");
    // The moved tab still has its unsaved URL.
    await tabs(page).nth(2).click();
    await expect.poll(() => page.locator(".cm-content").first().innerText()).toContain("/one");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("moves a tab with the context menu and remembers the order after a reload", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await threeTabs(page);
    const ids = await tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id")));
    await tabs(page).nth(2).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move left" }).click();
    await expect
      .poll(() => tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id"))))
      .toEqual([ids[0], ids[2], ids[1]]);
    await page.reload();
    await page.getByRole("button", { name: "Console" }).waitFor();
    await expect
      .poll(() => tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id"))))
      .toEqual([ids[0], ids[2], ids[1]]);
    expect(await titles(page)).toHaveLength(3);
    expect(errors).toEqual([]);
    await context.close();
  });
});
