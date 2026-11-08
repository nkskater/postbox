import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser, Page } from "playwright-core";
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

async function openEnv(page: Page, name: string) {
  await page.getByRole("button", { name: "Environments", exact: true }).click();
  await page.getByText(name, { exact: true }).first().click();
  await expect
    .poll(() =>
      page
        .locator("input")
        .evaluateAll((els, n) => els.some((e) => (e as HTMLInputElement).value === n), name),
    )
    .toBe(true);
}

describe("environments and variables", () => {
  it("saves variables and uses them in a sent request", async () => {
    const ws = await workspaceId();
    await post("/api/environments", { workspaceId: ws, name: "EnvSend", variables: [] });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await openEnv(page, "EnvSend");
    await page.getByPlaceholder("Add new variable").fill("host");
    await page.getByPlaceholder("Value").first().fill(targetUrl);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved").first().waitFor();
    const envs = (await (await fetch(`${baseUrl}/api/environments?workspaceId=${ws}`)).json()) as {
      id: string;
      name: string;
    }[];
    const id = envs.find((e) => e.name === "EnvSend")!.id;
    const saved = (await (await fetch(`${baseUrl}/api/environments/${id}`)).json()) as {
      variables: { key: string; value: string }[];
    };
    expect(saved.variables.map((v) => [v.key, v.value])).toEqual([["host", targetUrl]]);

    // Select the environment and send a request that uses {{host}}.
    await page
      .getByRole("combobox")
      .filter({ hasText: /No environment/ })
      .first()
      .click();
    await page.getByRole("option", { name: "EnvSend", exact: true }).click();
    await page.getByTitle("New request (Alt+T)").click();
    await typeInEditor(page, "Enter URL", "{{host}}/from-env");
    await page.getByTitle(/^Send/).click();
    await expect.poll(() => page.getByText('"url": "/from-env"').count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("keeps secrets masked and reveals only the chosen row", async () => {
    const ws = await workspaceId();
    await post("/api/environments", {
      workspaceId: ws,
      name: "EnvSecrets",
      variables: [
        { key: "plain", value: "p", type: "default", enabled: true },
        { key: "s1", value: "first-secret", type: "secret", enabled: true },
        { key: "s2", value: "second-secret", type: "secret", enabled: true },
      ],
    });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await openEnv(page, "EnvSecrets");
    const valueOf = (key: string) =>
      page.locator("div.group", { has: page.locator(`input[value="${key}"]`) }).getByPlaceholder("Value");
    expect(await valueOf("s1").getAttribute("type")).toBe("password");
    expect(await valueOf("s2").getAttribute("type")).toBe("password");
    // Reveal s2, then delete the row above it; s2 must stay revealed and nothing else may open up.
    await page
      .locator("div.group", { has: page.locator('input[value="s2"]') })
      .getByTitle("Reveal")
      .click();
    expect(await valueOf("s2").getAttribute("type")).toBe("text");
    await page.locator("div.group", { has: page.locator('input[value="plain"]') }).hover();
    await page
      .locator("div.group", { has: page.locator('input[value="plain"]') })
      .getByRole("button")
      .last()
      .click();
    await expect.poll(() => valueOf("s2").getAttribute("type")).toBe("text");
    expect(await valueOf("s1").getAttribute("type")).toBe("password");
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("import", () => {
  it("imports a cURL command as a request", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Import", exact: true }).first().click();
    await page.getByRole("tab", { name: "Raw text / cURL" }).click();
    await page
      .getByPlaceholder(/curl https/)
      .fill(`curl ${targetUrl}/curl-import -H 'Accept: application/json'`);
    await page.getByRole("button", { name: "Import", exact: true }).last().click();
    await expect.poll(() => page.getByText(/curl-import/).count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("imports a Postman collection file with its variables", async () => {
    const collection = {
      info: {
        name: "ImportedPostman",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      variable: [{ key: "base", value: "http://localhost" }],
      item: [{ name: "Ping", request: { method: "GET", url: "{{base}}/ping" } }],
    };
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Import", exact: true }).first().click();
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "postman.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(collection)),
      });
    await page.getByText("ImportedPostman").first().waitFor();
    const ws = await workspaceId();
    const tree = (await (await fetch(`${baseUrl}/api/workspaces/${ws}/tree`)).json()) as unknown;
    expect(JSON.stringify(tree)).toContain("ImportedPostman");
    expect(JSON.stringify(tree)).toContain("Ping");
    expect(errors).toEqual([]);
    await context.close();
  });
});
