import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser } from "playwright-core";
import { launch, openApp } from "./helpers";

const baseUrl = inject("baseUrl");
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

describe("console toggle", () => {
  it("opens and closes repeatedly from the status bar and the command palette without an error page", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    const toggle = page.getByRole("button", { name: "Console" });
    const filter = page.getByPlaceholder("Search messages");

    for (let i = 0; i < 3; i++) {
      await toggle.click();
      await filter.first().waitFor();
      await toggle.click();
      await filter.first().waitFor({ state: "detached" });
    }
    expect(await page.getByText(/could not load|couldn.t load/i).count()).toBe(0);

    await page.keyboard.press("Control+k");
    await page
      .getByPlaceholder(/command/i)
      .first()
      .fill("Toggle console");
    await page.keyboard.press("Enter");
    await filter.first().waitFor();
    await toggle.click();
    await filter.first().waitFor({ state: "detached" });

    expect(errors).toEqual([]);
    await context.close();
  });

  it("survives a scrollIntoView that returns a value (a polyfill or extension)", async () => {
    const { page, context } = await openApp(browser, baseUrl);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.evaluate(() => {
      Element.prototype.scrollIntoView = function () {
        return Promise.resolve() as unknown as undefined;
      };
    });
    const toggle = page.getByRole("button", { name: "Console" });
    await toggle.click();
    await toggle.click();
    await toggle.click();
    await toggle.click();
    expect(await page.getByText(/could not load|couldn.t load/i).count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });
});
