import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { launch, openApp } from "./helpers";

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
const workspaceId = async () =>
  ((await (await fetch(`${baseUrl}/api/workspaces`)).json()) as { id: string }[])[0].id;

/** Response sub-tabs are the ones after the response status; these names only exist there. */
const responseTab = (page: Page, name: RegExp) => page.getByRole("tab", { name }).last();
const selected = (page: Page, name: RegExp) => responseTab(page, name).getAttribute("aria-selected");
const openRequestTab = async (page: Page, name: string) => {
  await page.getByText(name, { exact: true }).first().dblclick();
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
};
const send = async (page: Page) => {
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await responseTab(page, /^Cookies/).waitFor();
};
const switchTo = (page: Page, name: string) =>
  page.locator("[data-tab-id]").filter({ hasText: name }).first().click();

describe("response sub-tabs", () => {
  it("remembers each request tab's response sub-tab across tab switches and re-sends", async () => {
    const ws = await workspaceId();
    const folder = await post("/api/folders", { workspaceId: ws, parentId: null, name: "ResponseTabs" });
    for (const name of ["First response", "Second response"])
      await post("/api/requests", {
        workspaceId: ws,
        folderId: folder.id,
        request: { name, method: "GET", url: `${targetUrl}/${encodeURIComponent(name)}` },
      });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByText("ResponseTabs", { exact: true }).first().click();

    await openRequestTab(page, "First response");
    await send(page);
    await responseTab(page, /^Headers \(/).click();
    expect(await selected(page, /^Headers \(/)).toBe("true");

    await openRequestTab(page, "Second response");
    await send(page);
    expect(await selected(page, /^Body$/)).toBe("true");
    await responseTab(page, /^Request$/).click();

    await switchTo(page, "First response");
    await expect.poll(() => selected(page, /^Headers \(/)).toBe("true");
    // Sending again keeps the choice.
    await send(page);
    await expect.poll(() => selected(page, /^Headers \(/)).toBe("true");

    await switchTo(page, "Second response");
    await expect.poll(() => selected(page, /^Request$/)).toBe("true");

    // Every sub-tab survives a round trip.
    for (const name of [/^Cookies/, /^Test Results/, /^Visualization$/, /^Body$/]) {
      await responseTab(page, name).click();
      await switchTo(page, "First response");
      await switchTo(page, "Second response");
      await expect.poll(() => selected(page, name)).toBe("true");
    }
    expect(errors).toEqual([]);
    await context.close();
  });
});
