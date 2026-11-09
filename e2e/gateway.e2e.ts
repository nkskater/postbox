import { it, expect, inject } from "vitest";
import { launch } from "./helpers";

it("configures an authenticated gateway, enforces its quota and displays redacted traces", async () => {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const base = inject("authUrl");
  try {
    const login = await context.request.post(`${base}/api/auth/login`, {
      data: { password: "e2e-correct-horse" },
    });
    expect(login.ok()).toBe(true);
    await page.goto(`${base}/gateway`);
    await page.getByRole("heading", { name: "Managed gateway", exact: true }).waitFor();
    await page.locator("summary").filter({ hasText: "Add provider" }).click();
    await page.getByLabel("Provider name", { exact: true }).fill("Browser gateway provider");
    await page.getByLabel("Provider base URL", { exact: true }).fill(inject("targetUrl"));
    await page.getByLabel("Provider vault secret", { exact: true }).fill("gateway-browser-secret");
    await page.getByLabel("Provider credential", { exact: true }).fill("private-browser-provider-key");
    await page.getByRole("button", { name: "Create provider", exact: true }).click();
    await page.getByRole("heading", { name: "Browser gateway provider", exact: true }).waitFor();
    expect(await page.getByLabel("Provider credential", { exact: true }).inputValue()).toBe("");
    await page.getByLabel("Route name", { exact: true }).fill("Browser gateway route");
    await page
      .getByLabel("Route provider", { exact: true })
      .selectOption({ label: "Browser gateway provider" });
    await page.getByLabel("Route type", { exact: true }).selectOption("llm");
    await page.getByLabel("Allowed models", { exact: true }).fill("model-one, model-two");
    expect(await page.getByLabel("Allowed models", { exact: true }).inputValue()).toBe(
      "model-one, model-two",
    );
    await page.locator("summary").filter({ hasText: "Advanced policy:" }).click();
    const advanced = page.getByLabel("Advanced gateway policy", { exact: true });
    const policy = JSON.parse(await advanced.inputValue());
    await advanced.fill(JSON.stringify({ ...policy, allowedModels: ["model-three"] }));
    expect(await page.getByLabel("Allowed models", { exact: true }).inputValue()).toBe("model-three");
    await page.getByLabel("Requests per minute", { exact: true }).fill("1");
    await page.getByLabel("Enable route", { exact: true }).check();
    await page.getByRole("button", { name: "Create route", exact: true }).click();
    await page.getByRole("heading", { name: /Browser gateway route/ }).waitFor();
    await page
      .getByLabel("Grant provider", { exact: true })
      .selectOption({ label: "Browser gateway provider" });
    await page.getByRole("button", { name: "Grant for 24 hours", exact: true }).click();
    const [workspace] = await (await context.request.get(`${base}/api/workspaces`)).json();
    let snapshot = await (
      await context.request.get(`${base}/api/gateway?workspaceId=${workspace.id}`)
    ).json();
    const route = snapshot.routes.find((r: { name: string }) => r.name === "Browser gateway route");
    const grant = snapshot.grants.find((g: { apiId: string }) => g.apiId === route.apiId);
    expect(grant.status).toBe("approved");
    const response = await context.request.post(`${base}${route.endpoint}/browser`, {
      headers: { "x-postbox-grant": grant.id },
      data: { model: "model-three", messages: [] },
    });
    expect(response.status()).toBe(200);
    const limited = await context.request.post(`${base}${route.endpoint}/browser`, {
      headers: { "x-postbox-grant": grant.id },
      data: { model: "model-three", messages: [] },
    });
    expect(limited.status()).toBe(429);
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await page.getByRole("cell", { name: "limited (quota)", exact: true }).waitFor();
    snapshot = await (await context.request.get(`${base}/api/gateway?workspaceId=${workspace.id}`)).json();
    expect(JSON.stringify(snapshot)).not.toContain("private-browser-provider-key");
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
      "private-browser-provider-key",
    );
    await page.screenshot({ path: "/tmp/postbox-120-gateway.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});
