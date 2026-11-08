import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser } from "playwright-core";
import { launch, openApp } from "./helpers";

const exec = promisify(execFile);
const baseUrl = inject("baseUrl");
const targetUrl = inject("targetUrl");
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

const call = async (method: string, route: string, body?: unknown) =>
  (
    await fetch(baseUrl + route, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  ).json();

describe("private runners", () => {
  it("enrols a runner, assigns a monitor to it and shows the check it ran", async () => {
    const [home] = (await call("GET", "/api/workspaces")) as { id: string }[];
    const folder = await call("POST", "/api/folders", {
      workspaceId: home.id,
      parentId: null,
      name: "RunnerSource",
    });
    await call("POST", "/api/requests", {
      workspaceId: home.id,
      folderId: folder.id,
      request: { name: "Get widget", method: "GET", url: `${targetUrl}/widgets/1` },
    });

    const { page, context, errors } = await openApp(browser, baseUrl);
    await page.getByRole("button", { name: "Monitors", exact: true }).click();
    await page.getByRole("button", { name: "Add runner" }).click();
    await page.getByLabel("Runner name", { exact: true }).fill("Edge");
    await page.getByLabel("Runner location").fill("Lab rack");
    await page.getByRole("button", { name: "Create runner" }).click();
    const token = await page.getByLabel("Runner token").inputValue();
    expect(token).toMatch(/^pbr_/);
    await page.getByRole("row", { name: /Edge/ }).getByText("offline").waitFor();

    await page.getByRole("button", { name: "New monitor" }).click();
    await page.getByLabel("Monitor name").fill("Edge monitor");
    await page.getByLabel("Monitor collection").selectOption({ label: "RunnerSource" });
    await page.getByLabel("Monitor runner").selectOption({ label: "Edge (Lab rack) · offline" });
    await page.getByRole("button", { name: "Save monitor" }).click();
    await page.getByRole("button", { name: "Run check now" }).waitFor();
    await expect.poll(() => page.getByRole("button", { name: "Run check now" }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: "Run check now" }).click();
    await page.getByRole("status").filter({ hasText: "Check queued or started" }).waitFor();

    // The runner process is the real CLI, reaching the server over HTTP like a remote one would.
    const { stderr } = await exec(
      process.execPath,
      [path.join(process.cwd(), "dist", "cli.mjs"), "runner", "start", "--server", baseUrl, "--once"],
      { env: { ...process.env, POSTBOX_RUNNER_TOKEN: token }, timeout: 60000 },
    );
    expect(stderr).toContain("running Edge monitor");

    await page
      .getByRole("row", { name: /passed/ })
      .getByText("Edge")
      .waitFor({ timeout: 15000 });
    await page.getByRole("row", { name: /Edge/ }).getByText("online").waitFor({ timeout: 15000 });

    // Revoking stops the runner from connecting.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Revoke runner Edge" }).click();
    await page.getByRole("row", { name: /Edge/ }).getByText("revoked").waitFor();
    await expect(
      exec(
        process.execPath,
        [path.join(process.cwd(), "dist", "cli.mjs"), "runner", "start", "--server", baseUrl, "--once"],
        {
          env: { ...process.env, POSTBOX_RUNNER_TOKEN: token },
          timeout: 60000,
        },
      ),
    ).rejects.toMatchObject({ code: 3 });
    expect(errors).toEqual([]);
    await context.close();
  });
});
