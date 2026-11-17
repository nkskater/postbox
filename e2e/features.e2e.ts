import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { launch, openApp } from "./helpers";

const baseUrl = inject("baseUrl");
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await save({ "features.mocks": null, "features.telemetry": null });
  await browser?.close();
});

async function save(values: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  expect(response.status).toBe(200);
}

const railButtons = async (page: Page) =>
  page.locator("nav button[title]").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("title")));

describe("feature switches", () => {
  it("removes switched-off areas from the sidebar and Settings, and brings them back", async () => {
    await save({ "features.mocks": false, "features.telemetry": false });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByTitle("Collections").waitFor();
    const off = await railButtons(page);
    expect(off).toContain("Collections");
    expect(off).not.toContain("Mocks");
    expect(off).not.toContain("Telemetry");
    expect((await fetch(`${baseUrl}/api/mocks?workspaceId=x`)).status).toBe(404);

    // The Features page lists the switches, and switching one on brings its tab back without a reload.
    await page.getByTitle(/^Settings \(/).click();
    await page.locator("nav").getByRole("button", { name: "Features" }).click();
    await page.getByRole("switch", { name: "Mock servers" }).click();
    await expect.poll(async () => (await railButtons(page)).includes("Mocks")).toBe(true);
    expect(await railButtons(page)).not.toContain("Telemetry");

    expect(errors).toEqual([]);
    await context.close();
  });
});
