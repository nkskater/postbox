import { it, expect, inject } from "vitest";
import { launch, openApp } from "./helpers";
it("reviews model suggestions before creating drafts or executing requests", async () => {
  const browser = await launch();
  const { page, context, errors } = await openApp(browser, inject("baseUrl"));
  try {
    let modelCalls = 0,
      executions = 0;
    await page.route("**/api/proxy", async (route) => {
      executions++;
      await route.fulfill({ json: { status: 200, body: "approved result" } });
    });
    await page.route("**/api/ai", async (route) => {
      modelCalls++;
      const input = route.request().postDataJSON();
      expect(input.assistant).toBe(true);
      expect(input.request.url).toBe("http://strata.test/v1/chat/completions");
      const toolCalls = [
        {
          id: "draft",
          name: "propose_request",
          valid: true,
          arguments: JSON.stringify({
            name: "Suggested status",
            method: "GET",
            url: "https://example.test/status",
          }),
        },
        {
          id: "execute",
          name: "propose_execution",
          valid: true,
          arguments: JSON.stringify({
            name: "Run status",
            method: "GET",
            url: "https://example.test/status",
          }),
        },
      ];
      await route.fulfill({
        contentType: "application/x-ndjson",
        body:
          JSON.stringify({
            type: "done",
            result: {
              text: "Review these suggestions.",
              toolCalls,
              reasoning: "",
              usage: {},
              finishReason: "tool_calls",
              model: "local",
              error: null,
            },
          }) + "\n",
      });
    });
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    await page.getByLabel("Server URL", { exact: true }).fill("http://strata.test");
    await page.getByLabel("Model", { exact: true }).fill("local-model");
    await page.getByLabel("API key (optional)", { exact: true }).fill("private-model-key");
    await page.getByLabel("Message", { exact: true }).fill("Suggest a status request");
    await page.getByRole("button", { name: "Ask assistant", exact: true }).click();
    await page.getByRole("button", { name: "Approve and open new draft", exact: true }).waitFor();
    expect(modelCalls).toBe(1);
    expect(executions).toBe(0);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("private-model-key");
    await page.getByRole("button", { name: "Approve and open new draft", exact: true }).click();
    await page.getByText("Suggested status", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    expect(executions).toBe(0);
    await page.getByRole("button", { name: "Approve and send request", exact: true }).click();
    await page.getByText(/approved result/).waitFor();
    expect(executions).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});
