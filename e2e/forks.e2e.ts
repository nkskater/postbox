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

async function openTab(page: Page, collection: string, tab: string) {
  await page.getByText(collection, { exact: true }).first().hover();
  await page
    .getByRole("button", {
      name: new RegExp(`Actions for collection ${collection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    })
    .first()
    .click();
  await page.getByRole("menuitem", { name: /Edit collection/ }).click();
  await page.getByRole("tab", { name: tab }).click();
}

describe("forks and merge requests", () => {
  it("forks a collection, proposes a change and merges it back", async () => {
    const [home] = (await call("GET", "/api/workspaces")) as { id: string }[];
    const parent = await call("POST", "/api/folders", {
      workspaceId: home.id,
      parentId: null,
      name: "ForkSource",
    });
    const created = await call("POST", "/api/requests", {
      workspaceId: home.id,
      folderId: parent.id,
      request: { name: "Get thing", method: "GET", url: `${targetUrl}/thing`, description: "original" },
    });
    const space = (await call("POST", "/api/workspaces", { name: "ForkSpace" })) as { id: string };

    // Fork it into the other workspace from the Forks tab.
    let { page, context, errors } = await openApp(browser, baseUrl);
    await openTab(page, "ForkSource", "Forks");
    await page.getByLabel("Fork destination").selectOption({ label: "ForkSpace" });
    await page.getByRole("button", { name: "Fork", exact: true }).click();
    await page.getByText("Forked").first().waitFor();
    const forks = (await call("GET", `/api/folders/${parent.id}/forks`)) as {
      id: string;
      folderId: string;
    }[];
    expect(forks).toHaveLength(1);
    const fork = forks[0];

    // Change the request in the fork.
    const tree = (await call("GET", `/api/workspaces/${space.id}/tree`)) as {
      requests: { id: string; folderId: string; name: string }[];
    };
    const copy = tree.requests.find((r) => r.folderId === fork.folderId)!;
    await call("PATCH", `/api/requests/${copy.id}`, { description: "improved in the fork" });

    // Open the fork, see it is ahead, and propose the change.
    await context.close();
    ({ page, context, errors } = await openApp(browser, baseUrl));
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "ForkSpace" }).click();
    await openTab(page, "ForkSource (fork)", "Forks");
    const thisFork = page.getByRole("region", { name: "This fork" });
    await thisFork.getByText("Has changes the original does not").waitFor();
    await page.getByLabel("Merge request title").fill("Better description");
    await page.getByRole("button", { name: "Open merge request" }).click();
    const detail = page.getByRole("region", { name: "Merge request", exact: true });
    await detail.getByText("Better description").waitFor();
    await detail
      .getByRole("list", { name: "Changes" })
      .getByText(/Get thing \(description\)/)
      .waitFor();

    // Merge it (this instance has no accounts, so the one administrator is an owner and may merge).
    await detail.getByRole("button", { name: "Merge", exact: true }).click();
    await detail.getByText(/Merged by/).waitFor();
    const parentRequest = (await call("GET", `/api/requests/${created.id}`)) as { description: string };
    expect(parentRequest.description).toBe("improved in the fork");
    await thisFork.getByText("Same as the original").waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });
});
