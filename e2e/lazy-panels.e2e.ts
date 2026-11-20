import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { launch, openApp } from "./helpers";

const baseUrl = inject("baseUrl");
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

/** Panels show a skeleton (aria-busy) only while their code loads; it must give way to content. */
async function settled(page: Page, what: string) {
  await expect
    .poll(async () => page.locator('[aria-busy="true"]').count(), {
      message: `${what} still loading`,
      timeout: 15_000,
    })
    .toBe(0);
}

describe("lazily loaded panels and dialogs", () => {
  it("opens every sidebar tab once and shows its content", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByTitle("Collections").waitFor();
    const titles = (await page
      .locator("nav button[title]")
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("title")))) as string[];
    expect(titles.length).toBeGreaterThanOrEqual(14);
    for (const title of titles) {
      await page.getByTitle(title, { exact: true }).first().click();
      await settled(page, title);
      // The panel rendered something beyond the rail itself.
      await expect
        .poll(async () => (await page.locator("body").innerText()).length, { message: title })
        .toBeGreaterThan(200);
    }
    expect(errors).toEqual([]);
    await context.close();
  });

  it("opens the lazily loaded dialogs and views", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByTitle("Collections").waitFor();

    await page.getByRole("button", { name: "Import", exact: true }).first().click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });

    await page.getByTitle("Keyboard shortcuts").click();
    await page.getByRole("dialog").getByText("Command palette").first().waitFor();
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+k");
    await page.getByRole("dialog").getByRole("combobox").waitFor();
    await page.keyboard.press("Escape");

    await page.getByTitle(/^Settings \(/).click();
    await settled(page, "Settings");
    await page.locator("nav", { hasText: "Server (environment)" }).waitFor();

    await page.getByTitle("Cookies").click();
    await settled(page, "Cookies");

    expect(errors).toEqual([]);
    await context.close();
  });
});
