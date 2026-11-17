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
  // Back to Full so the other browser tests see every area.
  const settings = (await (await fetch(`${baseUrl}/api/settings`)).json()) as {
    values: Record<string, unknown>;
  };
  const reset = Object.fromEntries(
    Object.keys(settings.values)
      .filter((k) => k.startsWith("features."))
      .map((k) => [k, null]),
  );
  await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: reset }),
  });
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
const railButtons = (page: Page) =>
  page.locator("nav button[title]").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("title")));

describe("feature presets", () => {
  it("applies Minimal from Settings and still runs a collection with scripts and an environment secret", async () => {
    const ws = await workspaceId();
    await post("/api/environments", {
      workspaceId: ws,
      name: "MinimalEnv",
      variables: [{ key: "apiToken", value: "s3cret-token", type: "secret", enabled: true }],
    });
    const folder = await post("/api/folders", { workspaceId: ws, parentId: null, name: "MinimalRun" });
    await post("/api/requests", {
      workspaceId: ws,
      folderId: folder.id,
      request: {
        name: "Scripted",
        method: "GET",
        url: `${targetUrl}/minimal?token={{apiToken}}&step={{step}}`,
        preRequestScript: 'pm.variables.set("step", "from-pre-request");',
        testScript: [
          'pm.test("secret and pre-request value were sent", () => {',
          "  const url = pm.response.json().url;",
          '  pm.expect(url).to.include("token=s3cret-token");',
          '  pm.expect(url).to.include("step=from-pre-request");',
          "});",
        ].join("\n"),
      },
    });

    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByTitle("Collections").waitFor();
    expect(await railButtons(page)).toContain("Mocks");

    await page.getByTitle(/^Settings \(/).click();
    await page.locator("nav").getByRole("button", { name: "Features" }).click();
    await page.getByRole("radio", { name: /^Minimal/ }).click();
    await expect.poll(() => page.getByTestId("feature-preset-current").innerText()).toBe("Current: Minimal");
    await expect
      .poll(async () =>
        (await railButtons(page)).filter(
          (t) => t !== "Collections" && t !== "Environments" && t !== "History",
        ),
      )
      .toEqual([]);
    expect((await fetch(`${baseUrl}/api/mocks?workspaceId=${ws}`)).status).toBe(404);

    // A single change afterwards turns the preset into Custom.
    await page.getByRole("switch", { name: "Datasets" }).click();
    await expect.poll(() => page.getByTestId("feature-preset-current").innerText()).toBe("Current: Custom");
    await page.getByRole("switch", { name: "Datasets" }).click();
    await expect.poll(() => page.getByTestId("feature-preset-current").innerText()).toBe("Current: Minimal");

    // The runner, scripts, variables and secrets keep working.
    await page.getByTitle("Collections").click();
    await page.getByText("MinimalRun", { exact: true }).first().hover();
    await page
      .getByRole("button", { name: /Actions for collection MinimalRun/ })
      .first()
      .click();
    await page.getByRole("menuitem", { name: /Edit collection/ }).click();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByRole("button", { name: /^Run MinimalRun/ }).waitFor();
    // Only the collection run remains: load testing is off.
    expect(await page.getByRole("tab", { name: "Load test" }).count()).toBe(0);
    await page.locator("section", { hasText: "Environment" }).getByRole("combobox").first().click();
    await page.getByRole("option", { name: "MinimalEnv", exact: true }).click();
    await page.getByRole("button", { name: /^Run MinimalRun/ }).click();
    await page.getByText(/Tests passed: 1/).waitFor();
    expect(await page.getByText(/Tests failed: [1-9]/).count()).toBe(0);

    expect(errors).toEqual([]);
    await context.close();
  });
});
