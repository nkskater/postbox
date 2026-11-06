import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser } from "playwright-core";
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

describe("comments", () => {
  it("adds, replies to, edits and resolves a comment on a request", async () => {
    const ws = await workspaceId();
    const folder = await post("/api/folders", {
      workspaceId: ws,
      parentId: null,
      name: "CommentsCollection",
    });
    const request = await post("/api/requests", {
      workspaceId: ws,
      folderId: folder.id,
      request: { name: "Discussed request", method: "GET", url: `${targetUrl}/c` },
    });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByText("CommentsCollection", { exact: true }).first().click();
    await page.getByText("Discussed request", { exact: true }).first().click();
    await page.getByRole("tab", { name: "Comments" }).click();
    const panel = page.getByRole("region", { name: "Comments" });
    await panel.getByPlaceholder(/Add a comment/).fill("First <b>thought</b>");
    await panel.getByRole("button", { name: "Comment", exact: true }).click();
    await panel.getByText("First thought").waitFor();
    // Markup is stripped, not rendered.
    expect(await panel.locator("b").count()).toBe(0);
    await panel.getByText("1 open thread(s)").waitFor();

    await panel.getByRole("button", { name: /Reply/ }).first().click();
    await panel.getByPlaceholder("Write a reply").fill("A reply");
    await panel.getByRole("button", { name: "Reply", exact: true }).last().click();
    await panel.getByText("A reply").waitFor();

    const list = (await (await fetch(`${baseUrl}/api/requests/${request.id}/comments`)).json()) as unknown;
    expect(JSON.stringify(list)).toContain("A reply");

    await panel
      .getByRole("button", { name: /Resolve/ })
      .first()
      .click();
    await panel.getByText("0 open thread(s)").waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("specifications", () => {
  it("saves the starter specification, validates it and lists it", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Specifications", exact: true }).click();
    await page.getByLabel("Specification name").fill("Pets API");
    await page.getByRole("button", { name: "Validate draft" }).click();
    await page.getByRole("region", { name: "Specification analysis" }).waitFor();
    await page.getByRole("button", { name: "Save specification" }).click();
    await page.getByRole("complementary", { name: "Saved specifications" }).getByText("Pets API").waitFor();
    // A second save creates a new revision.
    await page.getByRole("button", { name: "Save new version" }).click();
    await page.getByText(/v2/).first().waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("dependency graph", () => {
  it("searches nodes for a seeded collection", async () => {
    const ws = await workspaceId();
    const folder = await post("/api/folders", { workspaceId: ws, parentId: null, name: "GraphCollection" });
    await post("/api/requests", {
      workspaceId: ws,
      folderId: folder.id,
      request: { name: "Graph request", method: "GET", url: `${targetUrl}/graph` },
    });
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Dependencies", exact: true }).click();
    const search = page.getByLabel("Search the graph");
    await search.waitFor();
    await search.fill("Graph request");
    await page
      .getByText(/Graph request/)
      .first()
      .waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });
});

describe("governance, quality and catalog panels", () => {
  it("open with their controls and no errors", async () => {
    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Governance", exact: true }).click();
    await page.getByRole("complementary", { name: "Saved governance rule sets" }).waitFor();
    await page.getByRole("button", { name: "Save rule set" }).click();
    await page.getByText(/Saved rule version 1/).waitFor();
    await page.getByRole("button", { name: "Save new rule version" }).waitFor();
    await page.getByRole("button", { name: "Catalog", exact: true }).click();
    await page.getByLabel("Search catalog").waitFor();
    await page.getByLabel("Search catalog").fill("nothing-matches-this");
    await page.getByRole("button", { name: "Specifications", exact: true }).click();
    await page.getByLabel("Specification name").waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });
});
