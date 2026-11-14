import { expect, inject, it } from "vitest";
import { launch } from "./helpers";

it("edits, drags, connects, previews and deploys a workflow", async () => {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const base = inject("authUrl");
  try {
    expect(
      (
        await context.request.post(`${base}/api/auth/login`, { data: { password: "e2e-correct-horse" } })
      ).ok(),
    ).toBe(true);
    await page.goto(`${base}/flows`);
    await page.getByRole("button", { name: "New workflow", exact: true }).click();
    await page.getByLabel("Workflow name", { exact: true }).fill("Browser workflow");
    const input = page.getByTestId("flow-node-input");
    const before = await input.boundingBox();
    const heading = input.locator("strong");
    await heading.hover();
    await page.mouse.down();
    await page.mouse.move(before!.x + 160, before!.y + 70, { steps: 5 });
    await page.mouse.up();
    const after = await input.boundingBox();
    expect(after!.x).toBeGreaterThan(before!.x + 20);
    await page.getByRole("button", { name: "Add transform", exact: true }).click();
    await page.getByLabel("Block label", { exact: true }).fill("Extract greeting");
    await page.getByLabel("Value path", { exact: true }).fill("value.greeting");
    await page.getByLabel("Edge next", { exact: true }).selectOption("output");
    const added = page.locator('article[data-testid^="flow-node-transform_"]');
    const addedId = (await added.getAttribute("data-testid"))!.replace("flow-node-", "");
    await input.getByRole("button", { name: /Next/ }).click();
    await added.getByRole("button", { name: "Connect to Extract greeting", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Workflow saved", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await page.getByTestId(`flow-node-${addedId}`).waitFor();
    await page.getByLabel("Workflow input JSON", { exact: true }).fill('{"greeting":"hello workflow"}');
    await page.getByRole("button", { name: "Preview fixtures", exact: true }).click();
    await expect
      .poll(() => page.getByLabel("Workflow output", { exact: true }).textContent())
      .toBe('"hello workflow"');
    await page.getByRole("button", { name: /#2 Extract greeting/ }).click();
    expect(await page.getByLabel("Step trace", { exact: true }).textContent()).toContain("hello workflow");
    await page.getByRole("button", { name: "Publish saved version", exact: true }).click();
    await page.getByText("Published immutable version 1", { exact: true }).waitFor();
    await page.getByLabel("Deployment name", { exact: true }).fill("Browser deployment");
    await page.getByLabel("Deployment enabled", { exact: true }).check();
    await page.getByLabel("Bearer webhook enabled", { exact: true }).check();
    await page.getByRole("button", { name: "Save deployment", exact: true }).click();
    const tokenField = page.getByLabel("Webhook token", { exact: true });
    await tokenField.waitFor();
    const token = await tokenField.inputValue();
    const endpoint = await tokenField.locator("xpath=../following-sibling::code").textContent();
    const trigger = await fetch(`${base}${endpoint}?wait=1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "browser-delivery",
        "content-type": "application/json",
      },
      body: JSON.stringify({ greeting: "deployed greeting" }),
    });
    expect(trigger.status).toBe(200);
    expect(await trigger.json()).toMatchObject({ status: "passed", output: "deployed greeting" });
    await page.getByRole("button", { name: "Rotate webhook token", exact: true }).click();
    await expect.poll(() => tokenField.inputValue()).not.toBe(token);
    const old = await context.request.post(`${base}${endpoint}`, {
      headers: { authorization: `Bearer ${token}` },
      data: {},
    });
    expect(old.status()).toBe(404);
    await page.screenshot({ path: "/tmp/LAB-91-workflows.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});

it("previews request fixtures and executes pinned HTTP requests from the editor", async () => {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const base = inject("baseUrl");
  const post = async (path: string, data: unknown) => {
    const response = await context.request.post(base + path, { data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  try {
    const [workspace] = await (await context.request.get(`${base}/api/workspaces`)).json();
    const folder = await post("/api/folders", {
      workspaceId: workspace.id,
      name: "Workflow browser requests",
    });
    const request = await post("/api/requests", {
      workspaceId: workspace.id,
      folderId: folder.id,
      request: { name: "Workflow echo", method: "GET", url: `${inject("targetUrl")}/workflow-pinned` },
    });
    const workflow = await post("/api/workflows", {
      workspaceId: workspace.id,
      name: "HTTP browser workflow",
      graph: {
        schema: 1,
        entry: "http",
        nodes: [
          {
            id: "http",
            type: "request",
            label: "Echo",
            position: { x: 50, y: 80 },
            requestId: request.id,
            next: "output",
          },
          {
            id: "output",
            type: "output",
            label: "Output",
            position: { x: 400, y: 80 },
            expression: { kind: "path", path: "value.data.url" },
          },
        ],
      },
    });
    await page.goto(`${base}/flows`);
    await page.getByRole("button", { name: "HTTP browser workflow", exact: false }).click();
    await page
      .getByLabel("Request fixtures JSON", { exact: true })
      .fill(JSON.stringify({ [request.id]: { data: { url: "/fixture-only" } } }));
    await page.getByRole("button", { name: "Preview fixtures", exact: true }).click();
    await expect
      .poll(() => page.getByLabel("Workflow output", { exact: true }).textContent())
      .toBe('"/fixture-only"');
    await page.getByRole("button", { name: "Run HTTP requests", exact: true }).click();
    await expect
      .poll(() => page.getByLabel("Workflow output", { exact: true }).textContent())
      .toBe('"/workflow-pinned"');
    await page.getByRole("button", { name: "Publish saved version", exact: true }).click();
    await page.getByText("Published immutable version 1", { exact: true }).waitFor();
    expect(
      (
        await context.request.patch(`${base}/api/requests/${request.id}`, {
          data: { url: `${inject("targetUrl")}/workflow-changed` },
        })
      ).ok(),
    ).toBe(true);
    const deployed = await post(`/api/workflows/${workflow.id}/deployments`, {
      name: "Pinned HTTP",
      version: 1,
      enabled: true,
      webhookEnabled: true,
    });
    const response = await context.request.post(`${base}${deployed.endpoint}?wait=1`, {
      headers: { authorization: `Bearer ${deployed.token}` },
      data: {},
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "passed", output: "/workflow-pinned" });
  } finally {
    await context.close();
    await browser.close();
  }
});
