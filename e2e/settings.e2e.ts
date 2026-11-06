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

describe("settings", () => {
  it("opens every settings section without errors", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByTitle(/^Settings \(/).click();
    const nav = page.locator("nav", { hasText: "Server (environment)" });
    await nav.waitFor();
    const count = await nav.getByRole("button").count();
    expect(count).toBeGreaterThan(8);
    for (let i = 0; i < count; i++) {
      const button = nav.getByRole("button").nth(i);
      const label = (await button.innerText()).trim();
      await button.click();
      // Each section renders something other than an empty pane.
      await expect
        .poll(async () => (await page.locator("main, body").first().innerText()).length, { message: label })
        .toBeGreaterThan(200);
    }
    expect(errors).toEqual([]);
    await context.close();
  });

  it("finds a setting by search and keeps a changed value after a reload", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByTitle(/^Settings \(/).click();
    await page.getByPlaceholder(/Search settings/).fill("restore");
    const toggles = page.getByRole("switch");
    await toggles.first().waitFor();
    const before = await toggles.first().getAttribute("aria-checked");
    await toggles.first().click();
    await expect.poll(() => toggles.first().getAttribute("aria-checked")).not.toBe(before);
    const after = await toggles.first().getAttribute("aria-checked");
    await page.reload();
    await page.getByRole("button", { name: "Console" }).waitFor();
    await page.getByTitle(/^Settings \(/).click();
    await page.getByPlaceholder(/Search settings/).fill("restore");
    await expect.poll(() => page.getByRole("switch").first().getAttribute("aria-checked")).toBe(after);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("data management", () => {
  it("shows the database summary and produces a backup", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByTitle(/^Settings \(/).click();
    await page.locator("nav").getByRole("button", { name: "History & data" }).click();
    const database = page.getByRole("region", { name: "Database" });
    await database.waitFor();
    await database.getByText(/workspaces/).waitFor();
    const res = await fetch(`${baseUrl}/api/backup`);
    expect(res.status).toBe(200);
    const backup = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(backup).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("sign-in on a password-protected instance", () => {
  const authUrl = inject("authUrl");

  it("rejects a wrong password and accepts the right one", async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(authUrl);
    await page.getByPlaceholder("Password").waitFor();
    // The app is not reachable without signing in.
    expect((await fetch(`${authUrl}/api/workspaces`)).status).toBe(401);

    await page.getByPlaceholder("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.locator("p.text-destructive").waitFor();
    expect(page.url()).toContain("/login");

    await page.getByPlaceholder("Password").fill("e2e-correct-horse");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Console" }).waitFor({ timeout: 30000 });
    // The session survives a reload, and signing out returns to the login page.
    await page.reload();
    await page.getByRole("button", { name: "Console" }).waitFor();
    await page.getByTitle("Sign out").click();
    await page.getByPlaceholder("Password").waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });
});
