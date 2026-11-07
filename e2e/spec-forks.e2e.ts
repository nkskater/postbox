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

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};
const yaml = (t: string) => `openapi: 3.0.0\ninfo:\n  title: ${t}\n  version: "1"\npaths: {}\n`;

async function openSpec(page: Page, name: string) {
  await page.getByRole("button", { name: "Specifications", exact: true }).click();
  await page
    .getByRole("complementary", { name: "Saved specifications" })
    .getByText(name, { exact: true })
    .click();
}

describe("specification forks", () => {
  it("forks a specification, proposes a change and merges it back as a new revision", async () => {
    const [home] = (await call("GET", "/api/workspaces")) as { id: string }[];
    const parent = await call("POST", "/api/specifications", {
      workspaceId: home.id,
      name: "ForkSpecSource",
      format: "openapi",
      entrypoint: "openapi.yaml",
      files: [{ path: "openapi.yaml", content: yaml("v1") }],
    });
    const space = (await call("POST", "/api/workspaces", { name: "SpecForkSpace" })) as { id: string };

    let { page, context, errors } = await openApp(browser, baseUrl);
    await openSpec(page, "ForkSpecSource");
    await page.getByLabel("Specification forks").getByText("Forks and merge requests").click();
    await page.getByLabel("Fork destination").selectOption({ label: "SpecForkSpace" });
    await page.getByRole("button", { name: "Fork", exact: true }).click();
    await page.getByText("Forked").first().waitFor();
    const forks = (await call("GET", `/api/specifications/${parent.id}/forks`)) as {
      id: string;
      folderId: string;
    }[];
    expect(forks).toHaveLength(1);
    const fork = forks[0];

    // Change the fork's spec (a new revision with an extra file).
    const current = (await call("GET", `/api/specifications/${fork.folderId}`)) as {
      revision: number;
      entrypoint: string;
      files: { path: string; content: string }[];
    };
    const saved = await call("PATCH", `/api/specifications/${fork.folderId}`, {
      expectedRevision: current.revision,
      entrypoint: current.entrypoint,
      files: [...current.files, { path: "schemas/pet.yaml", content: "type: object\n" }],
      label: "add pet",
    });
    expect(saved.revision).toBe(current.revision + 1);

    await context.close();
    ({ page, context, errors } = await openApp(browser, baseUrl));
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "SpecForkSpace", exact: true }).click();
    await openSpec(page, "ForkSpecSource (fork)");
    await page.getByLabel("Specification forks").getByText("Forks and merge requests").click();
    const thisFork = page.getByRole("region", { name: "This fork" });
    await thisFork.getByText("Has changes the original does not").waitFor();
    await page.getByLabel("Merge request title").fill("Add the pet schema");
    await page.getByRole("button", { name: "Open merge request" }).click();
    const detail = page.getByRole("region", { name: "Merge request", exact: true });
    await detail.getByRole("list", { name: "Changes" }).getByText("+ schemas/pet.yaml").waitFor();
    await detail.getByRole("button", { name: "Merge", exact: true }).click();
    await detail.getByText(/Merged by/).waitFor();

    const after = (await call("GET", `/api/specifications/${parent.id}`)) as {
      revision: number;
      label: string;
      files: { path: string }[];
    };
    expect(after.revision).toBe(2);
    expect(after.label).toBe("Merged: Add the pet schema");
    expect(after.files.map((f) => f.path).sort()).toEqual(["openapi.yaml", "schemas/pet.yaml"]);
    await thisFork.getByText("Same as the original").waitFor();
    expect(errors).toEqual([]);
    await context.close();
    void space;
  });
});
