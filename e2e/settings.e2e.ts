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

// Workspace initialization clears early tabs; use its visible selection as the readiness signal.
async function waitForWorkspace(page: Page) {
  await expect
    .poll(async () => {
      const label = (await page.getByRole("combobox").first().innerText()).trim();
      return label.length > 0 && label !== "Workspace";
    })
    .toBe(true);
}

describe("settings", () => {
  it("opens every settings section without errors", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await waitForWorkspace(page);
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

  it("changes the default advertised MCP toolsets and keeps query overrides available", async () => {
    const saved = (await (await fetch(`${baseUrl}/api/settings`)).json()) as {
      saved: Record<string, unknown>;
    };
    const { page, context, errors } = await openApp(browser, baseUrl);
    await waitForWorkspace(page);
    const names = async (query = "") => {
      const response = await fetch(`${baseUrl}/api/mcp${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { result: { tools: { name: string }[] } }).result.tools.map(
        (tool) => tool.name,
      );
    };
    try {
      await page.getByTitle(/^Settings \(/).click();
      await page.locator("nav").getByRole("button", { name: "MCP & integrations" }).click();
      const input = page.getByRole("textbox", { name: "Default MCP toolsets" });
      await input.fill("mocks");
      await input.press("Enter");
      await expect.poll(() => names()).toContain("create_mock");
      expect(await names()).not.toContain("send_request");
      expect(await names("?toolsets=core,mocks")).toEqual(
        expect.arrayContaining(["send_request", "create_mock"]),
      );
      await page.reload();
      await page.getByRole("button", { name: "Console" }).waitFor();
      await page.getByTitle(/^Settings \(/).click();
      await page.locator("nav").getByRole("button", { name: "MCP & integrations" }).click();
      await expect
        .poll(() => page.getByRole("textbox", { name: "Default MCP toolsets" }).inputValue())
        .toBe("mocks");
      expect(errors).toEqual([]);
    } finally {
      const reset = await fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { "mcp.toolsets": saved.saved["mcp.toolsets"] ?? null } }),
      });
      expect(reset.status).toBe(200);
      await context.close();
    }
  });

  it("finds a setting by search and keeps a changed value after a reload", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await waitForWorkspace(page);
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
    // Settings live on the server and are shared by every test, so put the original value back.
    await page.getByRole("switch").first().click();
    await expect.poll(() => page.getByRole("switch").first().getAttribute("aria-checked")).toBe(before);
    await expect
      .poll(async () => {
        const saved = (await (await fetch(`${baseUrl}/api/settings`)).json()) as unknown;
        return JSON.stringify(saved).includes('"tabs.restore":false');
      })
      .toBe(false);
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("data management", () => {
  it("shows the database summary and produces a backup", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await waitForWorkspace(page);
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
