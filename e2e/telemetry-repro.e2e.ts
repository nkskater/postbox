import { it, expect, inject } from "vitest";
import { launch, openApp } from "./helpers";
import { attr, batch, span } from "../tests/fixtures/telemetry/traffic";

it("maps a production failure to an editable draft without sending it", async () => {
  const browser = await launch();
  const { page, context, errors } = await openApp(browser, inject("baseUrl"));
  try {
    const [workspace] = await (await context.request.get(`${inject("baseUrl")}/api/workspaces`)).json();
    const response = await context.request.post(`${inject("baseUrl")}/api/telemetry/sources`, {
      data: {
        workspaceId: workspace.id,
        config: { name: "Repro browser", serviceName: "checkout", enabled: true },
      },
    });
    expect(response.status()).toBe(201);
    const source = await response.json();
    const failure = span(9001, Date.now() - 1000, 50, 500, "/api/orders/{orderId}");
    failure.attributes = failure.attributes.map((a) =>
      a.key === "http.request.method" ? attr(a.key, "POST") : a,
    );
    const intake = await context.request.post(
      `${inject("baseUrl")}/api/telemetry/ingest/${source.source.id}/v1/traces`,
      {
        headers: { authorization: `Bearer ${source.token}` },
        data: batch([failure]),
      },
    );
    expect(intake.ok()).toBe(true);
    let sends = 0;
    await page.route("**/api/proxy", async (route) => {
      sends++;
      await route.abort();
    });
    await page.getByRole("button", { name: "Telemetry", exact: true }).click();
    await page.getByRole("button", { name: "POST /api/orders/:id", exact: true }).click();
    await page.getByRole("button", { name: "Reproduce", exact: true }).click();
    const panel = page.getByRole("region", { name: "Reproduce failure", exact: true });
    await panel.getByLabel("Target base URL", { exact: true }).fill("https://staging.example.test");
    await panel.getByLabel("Route placeholder 1", { exact: true }).fill("{{orderId}}");
    const open = panel.getByRole("button", { name: "Open draft (not sent)", exact: true });
    expect(await open.isEnabled()).toBe(false);
    await panel.getByRole("checkbox", { name: /I understand POST/ }).check();
    expect(await open.isEnabled()).toBe(true);
    expect(await panel.getByLabel("Missing or redacted fields").innerText()).toContain(
      "Request body was not captured",
    );
    expect(await panel.getByLabel("Original evidence").innerText()).not.toContain("SECRET");
    await open.click();
    await page.getByText("Repro: POST /api/orders/:id (HTTP 500)", { exact: true }).first().waitFor();
    const url = page
      .locator(".cm-content")
      .filter({ hasText: "https://staging.example.test/api/orders/{{orderId}}" })
      .first();
    await url.waitFor();
    expect(await url.innerText()).toBe("https://staging.example.test/api/orders/{{orderId}}");
    expect(sends).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});
