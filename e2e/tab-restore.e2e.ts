import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { launch, openApp, typeInEditor } from "./helpers";

/** LAB-295: a sent request keeps its response and its variable references when the user moves around. */
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

async function createLogin(collection: string) {
  const workspaceId = ((await (await fetch(`${baseUrl}/api/workspaces`)).json()) as { id: string }[])[0].id;
  const folder = (await post("/api/folders", { workspaceId, parentId: null, name: collection })) as {
    id: string;
  };
  await post("/api/requests", {
    workspaceId,
    folderId: folder.id,
    request: {
      name: "Login",
      method: "POST",
      url: `${targetUrl}/login`,
      headers: [{ key: "Authorization", value: "{{basic_auth_16vp}}", enabled: true }],
      params: [],
      // A short password that also occurs in the variable name above.
      auth: { type: "basic", basic: { username: "dbuser", password: "16" } },
      body: { mode: "raw", language: "json", raw: '{"username":"dbuser","password":"dbpass"}' },
    },
  });
}

async function openLogin(page: Page, collection: string) {
  await page.getByText(collection, { exact: true }).first().click();
  await page.getByText("Login", { exact: true }).first().click();
}

const headerShown = (page: Page) => page.getByText("{{basic_auth_16vp}}", { exact: true }).count();
const responseShown = (page: Page) => page.getByText('"url": "/login"').count();

describe("request tab state across view switches and reloads (LAB-295)", () => {
  it("keeps the response and the Authorization reference after switching views and tabs", async () => {
    await createLogin("Manhattan switch");
    const { page, context, errors } = await openApp(browser, baseUrl);
    await openLogin(page, "Manhattan switch");
    await page.getByRole("tab", { name: /^Headers/ }).click();
    await page.getByTitle(/^Send/).click();
    await expect.poll(() => responseShown(page)).toBeGreaterThan(0);
    await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));

    for (const view of ["Environments", "History", "Datasets", "Collections"])
      await page.getByRole("button", { name: view, exact: true }).first().click();
    await page.getByTitle("New request (Alt+T)").click();
    await page.getByTitle(/^Settings/).click();
    await page.getByTitle("Set up user accounts").click();
    await page.getByTitle("Back").click();
    await page.getByRole("button", { name: "Console" }).waitFor();
    await page.locator("div.h-9.overflow-x-auto > div", { hasText: "Login" }).first().click();

    expect(
      await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument),
    ).toBe(true);
    await expect.poll(() => responseShown(page)).toBeGreaterThan(0);
    await expect.poll(() => headerShown(page)).toBeGreaterThan(0);
    expect(await page.getByText("[REDACTED]").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("restores the saved request from the server after a reload and sends the real values", async () => {
    await createLogin("Manhattan reload");
    const { page, context, errors } = await openApp(browser, baseUrl);
    await openLogin(page, "Manhattan reload");
    await page.getByRole("tab", { name: /^Headers/ }).click();
    await expect.poll(() => headerShown(page)).toBeGreaterThan(0);
    await page.reload();
    await page.getByRole("button", { name: "Console" }).waitFor();
    await page
      .getByRole("tab", { name: /^Headers/ })
      .first()
      .click();
    await expect.poll(() => headerShown(page)).toBeGreaterThan(0);
    expect(await page.getByRole("alert").filter({ hasText: "withheld" }).count()).toBe(0);
    await page.getByTitle(/^Send/).click();
    // The echo target returns the body it received: the stored password, not a placeholder.
    await expect.poll(() => page.getByText("dbpass").count()).toBeGreaterThan(0);
    expect(await page.getByText("REDACTED").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("marks an unsaved secret as withheld after a reload and refuses to send it", async () => {
    const { page, context } = await openApp(browser, baseUrl);
    await page.getByTitle("New request (Alt+T)").click();
    await typeInEditor(page, "Enter URL", `${targetUrl}/unsaved`);
    await page.getByRole("tab", { name: /^Headers/ }).click();
    await page.getByRole("button", { name: "Bulk Edit" }).click();
    await page.getByPlaceholder("key:value").fill("X-Api-Key:literal-secret-1234");
    await page.getByRole("button", { name: "Key-Value Edit" }).click();
    // Let the store write the draft to browser storage before reloading.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("postbox-ui")?.includes("X-Api-Key") ?? false))
      .toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "Console" }).waitFor();
    const alert = page.getByRole("alert").filter({ hasText: "withheld" });
    await expect.poll(() => alert.count()).toBe(1);
    expect(await page.getByText("literal-secret-1234").count()).toBe(0);
    expect(await page.getByText("[REDACTED]").count()).toBe(0);
    await page.getByTitle(/^Send/).click();
    await expect.poll(() => page.getByText(/Re-enter the fields marked/).count()).toBeGreaterThan(0);
    expect(await page.getByText('"url": "/unsaved"').count()).toBe(0);
    await context.close();
  });
});
