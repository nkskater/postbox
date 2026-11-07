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

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};
const workspaceId = async () => ((await call("GET", "/api/workspaces")) as { id: string }[])[0].id;

async function openCollectionTab(page: Page, name: string, tab: string) {
  await page.getByText(name, { exact: true }).first().hover();
  await page
    .getByRole("button", { name: new RegExp(`Actions for collection ${name}`) })
    .first()
    .click();
  await page.getByRole("menuitem", { name: /Edit collection/ }).click();
  await page.getByRole("tab", { name: tab }).click();
}

describe("repository section", () => {
  it("shows a collection's files, checksum and commands, matching the API", async () => {
    const ws = await workspaceId();
    const folder = await call("POST", "/api/folders", { workspaceId: ws, parentId: null, name: "RepoShown" });
    await call("POST", "/api/requests", {
      workspaceId: ws,
      folderId: folder.id,
      request: {
        name: "Fetch thing",
        method: "GET",
        url: `${targetUrl}/thing`,
        testScript: "pm.test('x', () => {});",
      },
    });
    const pulled = (await call("GET", `/api/folders/${folder.id}/files`)) as {
      checksum: string;
      files: Record<string, string>;
    };
    const { page, context, errors } = await openApp(browser, baseUrl);
    await openCollectionTab(page, "RepoShown", "Repository");
    const panel = page.getByLabel("Repository", { exact: true });
    await panel.getByTestId("repository-checksum").waitFor();
    expect(await panel.getByTestId("repository-checksum").getAttribute("title")).toBe(pulled.checksum);
    await panel.getByText(`${Object.keys(pulled.files).length} file(s)`).waitFor();
    await panel.getByRole("button", { name: "Show files" }).click();
    const list = panel.getByRole("list", { name: "Files" });
    await list.getByText("collection.json").waitFor();
    await list.getByText(/fetch-thing--.*\.test\.js/).waitFor();
    await panel.getByText(`postbox collection pull ${folder.id} --dir ./reposhown`).waitFor();
    await panel.getByText("postbox collection push --dir ./reposhown --dry-run").waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });

  it("is available on environments and specifications too", async () => {
    const ws = await workspaceId();
    const env = await call("POST", "/api/environments", {
      workspaceId: ws,
      name: "RepoEnv",
      variables: [{ key: "host", value: "x", type: "default", enabled: true }],
    });
    const spec = await call("POST", "/api/specifications", {
      workspaceId: ws,
      name: "RepoSpec",
      format: "openapi",
      entrypoint: "openapi.yaml",
      files: [
        { path: "openapi.yaml", content: "openapi: 3.0.0\ninfo: {title: T, version: '1'}\npaths: {}\n" },
      ],
    });
    const { page, context, errors } = await openApp(browser, baseUrl);

    await page.getByRole("button", { name: "Environments", exact: true }).click();
    await page.getByText("RepoEnv", { exact: true }).first().click();
    await page.getByText("Repository", { exact: true }).click();
    await page.getByText(`postbox env pull ${env.id} --dir ./repoenv`).waitFor();
    await page.getByText("2 file(s)").waitFor();

    await page.getByRole("button", { name: "Specifications", exact: true }).click();
    await page.getByRole("complementary", { name: "Saved specifications" }).getByText("RepoSpec").click();
    await page.getByLabel("Specification repository").getByText("Repository", { exact: true }).click();
    await page.getByText(`postbox spec pull ${spec.id} --dir ./repospec`).waitFor();
    await page.getByLabel("Specification repository").getByText("2 file(s)").waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });
});
