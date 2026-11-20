import { describe, expect, it } from "vitest";
import {
  applyEdit,
  changedFields,
  editableSnapshot,
  parseRequestEdit,
  REQUEST_ASSISTANT_TOOLS,
  requestContext,
  restoreMasked,
  staleFields,
  type EditableRequest,
} from "@/core/assistant/request-edit";
import { diffLines } from "@/core/assistant/diff";
import { DEFAULT_SETTINGS, type RequestDef } from "@/core/types";
import { REDACTION_MASK } from "@/core/variables/redact";

const base = (): RequestDef => ({
  id: "r1",
  name: "Get user",
  method: "GET",
  url: "https://api.example.test/users/{{id}}",
  description: "",
  params: [{ key: "expand", value: "roles", enabled: true }],
  headers: [{ key: "Accept", value: "application/json", enabled: true }],
  auth: { type: "bearer", bearer: { token: "real-token-12345" } },
  body: { mode: "none" },
  preRequestScript: "",
  testScript: "",
  settings: { ...DEFAULT_SETTINGS },
  examples: [],
});
const edit = (changes: Record<string, unknown>, summary = "") =>
  parseRequestEdit(JSON.stringify({ summary, changes }));

describe("request-tab assistant edits", () => {
  it("offers edit, send and save tools with a closed argument schema", () => {
    expect(REQUEST_ASSISTANT_TOOLS.map((t) => t.name)).toEqual([
      "propose_request_edit",
      "propose_send",
      "propose_save",
    ]);
    const params = JSON.parse(REQUEST_ASSISTANT_TOOLS[0].parameters);
    expect(params.additionalProperties).toBe(false);
    expect(Object.keys(params.properties.changes.properties)).toEqual(
      expect.arrayContaining([
        "params",
        "headers",
        "auth",
        "body",
        "preRequestScript",
        "testScript",
        "contract",
        "settings",
      ]),
    );
  });

  it("validates proposals with the request schema and refuses unknown or empty changes", () => {
    expect(() => edit({ command: "rm -rf /" })).toThrow(/Unknown request fields/);
    expect(() => edit({ id: "other" })).toThrow(/Unknown request fields/);
    expect(() => edit({})).toThrow(/changes nothing/);
    expect(() => edit({ method: 42 })).toThrow();
    expect(() => edit({ headers: "Accept: x" })).toThrow();
    expect(() => edit({ body: { mode: "telepathy" } })).toThrow();
    expect(() => edit({ settings: { timeoutMs: "soon" } })).toThrow();
    expect(() => parseRequestEdit("{not json")).toThrow();
    expect(edit({ url: "https://x.test" }, "Point at x").summary).toBe("Point at x");
  });

  it("applies an approved edit to every tab of the request", () => {
    const draft = base();
    const proposal = edit({
      name: "Create user",
      description: "Creates a user",
      method: "POST",
      url: "https://api.example.test/users",
      params: [],
      headers: [
        { key: "Accept", value: "application/json", enabled: true },
        { key: "X-Trace", value: "{{traceId}}", enabled: true },
      ],
      auth: { type: "apikey", apikey: { key: "X-Api-Key", value: "{{apiKey}}", in: "header" } },
      body: { mode: "raw", language: "json", raw: '{"name":"Ada"}' },
      preRequestScript: 'pm.variables.set("traceId", "t-1");',
      testScript: 'pm.test("created", () => pm.response.to.have.status(201));',
      contract: { parameters: [], responseBody: { type: "object", required: ["id"] } },
      settings: { timeoutMs: 5000, followRedirects: false },
    });
    const changes = changedFields(draft, proposal.changes).map((c) => c.field);
    expect(changes).toEqual([
      "name",
      "description",
      "method",
      "url",
      "params",
      "headers",
      "auth",
      "body",
      "preRequestScript",
      "testScript",
      "contract",
      "settings",
    ]);
    const next = applyEdit(draft, proposal.changes, changes);
    expect(next).toMatchObject({
      method: "POST",
      headers: [{ key: "Accept" }, { key: "X-Trace", value: "{{traceId}}" }],
      auth: { type: "apikey" },
      body: { mode: "raw", raw: '{"name":"Ada"}' },
      testScript: expect.stringContaining("201"),
      contract: { responseBody: { required: ["id"] } },
    });
    // Settings merge: unchanged settings are kept.
    expect(next.settings).toMatchObject({
      timeoutMs: 5000,
      followRedirects: false,
      verifySsl: DEFAULT_SETTINGS.verifySsl,
    });
    expect(next.id).toBe("r1");
  });

  it("applies only the selected fields", () => {
    const draft = base();
    const proposal = edit({ url: "https://other.test", testScript: "pm.test('x', () => {});" });
    const next = applyEdit(draft, proposal.changes, ["testScript"]);
    expect(next.url).toBe(draft.url);
    expect(next.testScript).toContain("pm.test");
  });

  it("never overwrites a real credential with the redaction placeholder", () => {
    const draft = base();
    const proposal = edit({ auth: { type: "bearer", bearer: { token: REDACTION_MASK } }, headers: [] });
    expect(changedFields(draft, proposal.changes).map((c) => c.field)).toEqual(["headers"]);
    const next = applyEdit(draft, proposal.changes, ["auth", "headers"]);
    expect(next.auth).toEqual({ type: "bearer", bearer: { token: "real-token-12345" } });
    expect(restoreMasked(undefined, REDACTION_MASK)).toBe(REDACTION_MASK);
  });

  it("detects fields the person changed after a proposal was made", () => {
    const snapshot = editableSnapshot(base());
    const current: EditableRequest = { ...snapshot, testScript: "pm.test('mine', () => {});" };
    expect(staleFields(snapshot, current, ["testScript", "headers"])).toEqual(["testScript"]);
    expect(staleFields(snapshot, snapshot, ["testScript"])).toEqual([]);
  });

  it("builds the context from the current draft and last response, hiding secrets unless allowed", () => {
    const draft = base();
    const response = {
      status: 401,
      statusText: "Unauthorized",
      headers: [["www-authenticate", "Bearer"]] as [string, string][],
      bodyText: '{"error":"bad token real-token-12345"}',
      isBinary: false,
      size: 40,
    };
    const hidden = requestContext(draft, {
      secrets: ["real-token-12345", "env-secret-xyz"],
      response,
      tests: [{ name: "status is 200", passed: false, error: "expected 401 to equal 200" }],
      variables: { apiKey: "env-secret-xyz", region: "eu" },
    });
    expect(hidden).toContain("401 Unauthorized");
    expect(hidden).toContain("FAIL status is 200");
    expect(hidden).toContain("{{id}}");
    expect(hidden).toContain('"region": "eu"');
    expect(hidden).not.toContain("real-token-12345");
    expect(hidden).not.toContain("env-secret-xyz");
    const shown = requestContext(draft, { secrets: [], response, variables: { apiKey: "env-secret-xyz" } });
    expect(shown).toContain("real-token-12345");
    expect(shown).toContain("env-secret-xyz");
    expect(requestContext(draft, { secrets: [] })).toContain("has not been sent");
    const big = requestContext(draft, {
      secrets: [],
      response: { ...response, bodyText: "x".repeat(50_000) },
    });
    expect(big).toContain("more characters");
  });

  it("diffs lines for the review", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });
});
