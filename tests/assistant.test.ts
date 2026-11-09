import { describe, it, expect } from "vitest";
import { assistantEndpoint, assistantProposal, ASSISTANT_TOOLS } from "@/core/assistant/model";
import { DEFAULT_AI_CONFIG } from "@/core/ai/types";
import { buildAiPayload } from "@/core/ai/build";
import { parseResponse } from "@/core/ai/parse";
describe("assistant server configuration and proposals", () => {
  it("accepts Strata prefixes, Ollama roots and full completion URLs", () => {
    expect(assistantEndpoint("http://ollama:11434")).toBe("http://ollama:11434/v1/chat/completions");
    expect(assistantEndpoint("https://strata.example/api/v1/")).toBe(
      "https://strata.example/api/v1/chat/completions",
    );
    expect(assistantEndpoint("https://strata.example/v1/chat/completions")).toBe(
      "https://strata.example/v1/chat/completions",
    );
  });
  it("refuses credentials embedded in endpoints and unsupported transports", () => {
    for (const url of [
      "file:///etc/passwd",
      "https://user:password@server",
      "https://server?token=secret",
      "https://server#secret",
    ])
      expect(() => assistantEndpoint(url)).toThrow();
  });
  it("validates proposals before request construction and refuses arbitrary actions", () => {
    expect(
      assistantProposal.parse({ name: "Status", method: "GET", url: "https://example.test/health" }),
    ).toMatchObject({ testScript: "", body: "" });
    for (const proposal of [
      { name: "", method: "GET", url: "" },
      { name: "Status", method: "SHELL", url: "" },
      { name: "Status", method: "GET", url: "", command: "rm -rf /" },
    ])
      expect(assistantProposal.safeParse(proposal).success).toBe(false);
  });
  for (const provider of ["strata", "ollama"] as const)
    it(`builds and decodes compatible ${provider} tool proposals`, () => {
      const config = { ...DEFAULT_AI_CONFIG, provider, model: "local-test", tools: ASSISTANT_TOOLS };
      expect(buildAiPayload(config)).toMatchObject({
        model: "local-test",
        stream: true,
        tool_choice: "auto",
      });
      const result = parseResponse(
        provider,
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Review this request",
                tool_calls: [
                  {
                    id: "p1",
                    type: "function",
                    function: {
                      name: "propose_request",
                      arguments: JSON.stringify({
                        name: "Status",
                        method: "GET",
                        url: "https://example.test/health",
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );
      expect(result.toolCalls[0]).toMatchObject({ id: "p1", name: "propose_request", valid: true });
      expect(assistantProposal.parse(JSON.parse(result.toolCalls[0].arguments)).method).toBe("GET");
    });
});
