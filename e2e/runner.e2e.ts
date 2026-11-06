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

/** A collection with a passing request and one whose test fails. */
async function seed(name: string) {
  const ws = await workspaceId();
  const folder = await post("/api/folders", { workspaceId: ws, parentId: null, name });
  const mk = (reqName: string, testScript: string) =>
    post("/api/requests", {
      workspaceId: ws,
      folderId: folder.id,
      request: { name: reqName, method: "GET", url: `${targetUrl}/ok?n={{n}}`, testScript },
    });
  await mk("Passing", 'pm.test("status ok",()=>pm.response.to.have.status(200));');
  await mk("Failing", 'pm.test("always fails",()=>pm.expect(1).to.equal(2));');
  return folder.id as string;
}

async function openRunner(page: Page, name: string) {
  await page.getByText(name, { exact: true }).first().hover();
  await page
    .getByRole("button", { name: new RegExp(`Actions for collection ${name}`) })
    .first()
    .click();
  await page.getByRole("menuitem", { name: /Edit collection/ }).click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^Run ${name}`) }).waitFor();
}

describe("collection runner", () => {
  it("runs a collection and reports passed and failed tests", async () => {
    await seed("RunnerBasic");
    const { page, context, errors } = await openApp(browser, baseUrl);
    await openRunner(page, "RunnerBasic");
    await page.getByRole("button", { name: /^Run RunnerBasic/ }).click();
    await page.getByText(/Tests passed: 1/).waitFor();
    await page.getByText(/Tests failed: 1/).waitFor();
    await page.getByRole("button", { name: /^failed \(1\)/ }).click();
    await page.getByText("Failing", { exact: true }).last().waitFor();
    await page.getByRole("button", { name: /^all \(2\)/ }).click();
    expect(errors).toEqual([]);
    await context.close();
  });

  it("iterates over an uploaded CSV data file", async () => {
    await seed("RunnerData");
    const { page, context, errors } = await openApp(browser, baseUrl);
    await openRunner(page, "RunnerData");
    await page.locator('input[type="file"]').setInputFiles({
      name: "rows.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("n\n1\n2\n3\n"),
    });
    await page.getByText(/Loaded 3 rows/).first().waitFor();
    await page.getByRole("button", { name: /^Run RunnerData/ }).click();
    await page.getByText(/Iterations: 3/).waitFor();
    await page.getByText(/Requests: 6/).waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });

  it("keeps the run result when switching tabs and back", async () => {
    await seed("RunnerKeep");
    const { page, context, errors } = await openApp(browser, baseUrl);
    await openRunner(page, "RunnerKeep");
    await page.getByRole("button", { name: /^Run RunnerKeep/ }).click();
    await page.getByText(/Tests passed: 1/).waitFor();
    await page.getByTitle("New request (Alt+T)").click();
    await page.locator("div.h-9.overflow-x-auto > div").last().waitFor();
    await page.locator("div.h-9.overflow-x-auto > div").filter({ hasText: /RunnerKeep/ }).last().click();
    await page.getByText(/Tests passed: 1/).waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });

  it("opens the load test panel and runs a short load", async () => {
    await seed("RunnerLoad");
    const { page, context, errors } = await openApp(browser, baseUrl);
    await openRunner(page, "RunnerLoad");
    await page.getByRole("tab", { name: "Load test" }).click();
    await page.getByRole("button", { name: /Start load test/ }).waitFor();
    await page.getByLabel("Virtual users", { exact: true }).fill("2");
    await page.getByLabel("Duration", { exact: true }).fill("2s");
    await page.getByRole("button", { name: /Start load test/ }).click();
    await page.getByRole("link", { name: "Export JSON" }).waitFor({ timeout: 40000 });
    await page.getByText(/Passed · errorRate/).waitFor();
    await page.getByRole("button", { name: /Start load test/ }).waitFor();
    await page.getByRole("tab", { name: "Collection run" }).click();
    await page.getByRole("button", { name: /^Run RunnerLoad/ }).waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });

  it("creates, disables and deletes a schedule", async () => {
    await seed("RunnerSched");
    const { page, context, errors } = await openApp(browser, baseUrl);
    await openRunner(page, "RunnerSched");
    await page.getByRole("button", { name: "New schedule" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Nightly");
    await page.getByPlaceholder("0 9 * * 1-5").fill("0 3 * * *");
    await page.getByRole("button", { name: "Save schedule" }).click();
    await page.getByText("Nightly", { exact: true }).waitFor();
    const enabled = async () => {
      const ws = await workspaceId();
      const list = (await (await fetch(`${baseUrl}/api/schedules?workspaceId=${ws}`)).json()) as {
        name: string;
        enabled: boolean;
      }[];
      return list.find((x) => x.name === "Nightly")?.enabled;
    };
    const before = await enabled();
    expect(before).toBeDefined();
    await page.getByRole("switch", { name: "Enable Nightly" }).click();
    await expect.poll(enabled).toBe(!before);
    expect(errors).toEqual([]);
    await context.close();
  });
});
