import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser } from "playwright-core";
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

describe("error capture", () => {
  it("records uncaught page errors, so a crash cannot pass unnoticed", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.evaluate(() =>
      setTimeout(() => {
        throw new Error("deliberate");
      }),
    );
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0]).toContain("deliberate");
    await context.close();
  });
});

describe("app shell", () => {
  it("loads without errors and every top-level panel opens", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    for (const name of [
      "Telemetry",
      "Governance",
      "Specifications",
      "Monitors",
      "MCP client",
      "Catalog",
      "Dependencies",
      "Packages",
      "Mocks",
      "Datasets",
      "Environments",
      "History",
      "Collections",
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.waitForTimeout(300);
    }
    for (const title of ["Cookies", "Keyboard shortcuts", "Settings (Ctrl+,)"]) {
      await page.getByTitle(title).click();
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
    }
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("sending a request", () => {
  it("creates a request, sends it, and shows the response", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Create a new request" }).click();
    await typeInEditor(page, "Enter URL", `${targetUrl}/hello?x=1`);
    await page.getByTitle(/^Send/).click();
    await expect.poll(() => page.getByText('"method": "GET"').count()).toBeGreaterThan(0);
    await expect.poll(() => page.getByText('"url": "/hello?x=1"').count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("console panel", () => {
  it("opens and closes by the button, the close icon and repeatedly without crashing", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Create a new request" }).click();
    await typeInEditor(page, "Enter URL", `${targetUrl}/log`);
    await page.getByTitle(/^Send/).click();
    await expect.poll(() => page.getByText('"method": "GET"').count()).toBeGreaterThan(0);
    const toggle = page.getByRole("button", { name: /^Console/ });
    for (let i = 0; i < 3; i++) {
      await toggle.click();
      await expect.poll(() => page.getByTitle("Close", { exact: true }).count()).toBeGreaterThan(0);
      await toggle.click();
      await expect.poll(() => page.getByTitle("Close", { exact: true }).count()).toBe(0);
    }
    await toggle.click();
    await page.getByTitle("Close", { exact: true }).click();
    await expect.poll(() => page.getByTitle("Close", { exact: true }).count()).toBe(0);
    expect(await page.getByTitle(/^Send/).count()).toBe(1);
    expect(errors).toEqual([]);
    await context.close();
  });
});
