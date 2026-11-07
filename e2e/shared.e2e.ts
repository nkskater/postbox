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

async function openSharing(page: Page, name: string) {
  await page.getByText(name, { exact: true }).first().hover();
  await page
    .getByRole("button", { name: new RegExp(`Actions for collection ${name}`) })
    .first()
    .click();
  await page.getByRole("menuitem", { name: /Edit collection/ }).click();
  await page.getByRole("tab", { name: "Sharing" }).click();
}

describe("shared collection dependencies", () => {
  it("publishes a version, installs it in another workspace and updates it", async () => {
    const [home] = (await call("GET", "/api/workspaces")) as { id: string }[];
    const source = await call("POST", "/api/folders", {
      workspaceId: home.id,
      parentId: null,
      name: "SharedSource",
    });
    await call("POST", "/api/requests", {
      workspaceId: home.id,
      folderId: source.id,
      request: {
        name: "Get thing",
        method: "GET",
        url: `${targetUrl}/thing`,
        headers: [{ key: "Authorization", value: "Bearer do-not-share", enabled: true }],
      },
    });

    // Publish version 1.0.0 from the collection's Sharing tab.
    let { page, context, errors } = await openApp(browser, baseUrl);
    await openSharing(page, "SharedSource");
    await page.getByLabel("Release version").fill("1.0.0");
    await page.getByLabel("Release notes").fill("First release");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const published = page.getByRole("region", { name: "Published versions" });
    await published.getByText("1.0.0").waitFor();
    await published.getByText("First release").waitFor();
    const releases = (await call("GET", `/api/folders/${source.id}/releases`)) as {
      id: string;
      checksum: string;
    }[];
    expect(releases).toHaveLength(1);
    expect(JSON.stringify(releases)).not.toContain("do-not-share");

    // Switch to another workspace and install it from Import → Shared.
    await call("POST", "/api/workspaces", { name: "ConsumerWs" });
    await context.close();
    ({ page, context, errors } = await openApp(browser, baseUrl));
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "ConsumerWs" }).click();
    await page.getByRole("button", { name: "Import", exact: true }).first().click();
    await page.getByRole("tab", { name: "Shared" }).click();
    await page.getByRole("button", { name: "Install SharedSource 1.0.0" }).click();
    await page.getByText("Installed SharedSource 1.0.0").first().waitFor();
    await page.keyboard.press("Escape");

    await openSharing(page, "SharedSource");
    const installed = page.getByRole("region", { name: "Installed dependency" });
    await installed.getByText("Up to date").waitFor();

    // The author publishes a new version; the installed copy notices and updates.
    await call("PATCH", `/api/requests/${(await requestIdOf(source.id)) as string}`, {
      description: "Now documented",
    });
    const next = await call("POST", `/api/folders/${source.id}/releases`, {
      version: "1.1.0",
      notes: "Docs",
    });
    expect(next.version).toBe("1.1.0");
    await page.reload();
    await page.getByRole("button", { name: "Console" }).waitFor();
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "ConsumerWs" }).click();
    await openSharing(page, "SharedSource");
    await installed.getByText("Update available").waitFor();
    await installed.getByRole("button", { name: "Check for changes" }).click();
    const preview = installed.getByLabel("Update preview");
    await preview.getByText(/Get thing \(description\)/).waitFor();
    await preview.getByRole("button", { name: "Update to 1.1.0" }).click();
    await installed.getByText("Up to date").waitFor();
    await installed.getByText(/SharedSource · 1\.1\.0/).waitFor();
    expect(errors).toEqual([]);
    await context.close();
  });
});

async function requestIdOf(folderId: string) {
  const [home] = (await call("GET", "/api/workspaces")) as { id: string }[];
  const tree = (await call("GET", `/api/workspaces/${home.id}/tree`)) as {
    requests: { id: string; folderId: string }[];
  };
  return tree.requests.find((r) => r.folderId === folderId)!.id;
}
