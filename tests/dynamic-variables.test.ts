import { afterEach, describe, expect, it, vi } from "vitest";
import { isIP } from "node:net";
import { createDynamicVariables, generateDynamic, DYNAMIC_VARIABLES } from "@/core/variables/dynamic";
import {
  DYNAMIC_MANIFEST,
  DYNAMIC_VARIABLE_NAMES,
  isDynamicVariable,
} from "@/core/variables/dynamic-catalog";
import { emptyScopes, resolveTemplate } from "@/core/variables/resolver";
import { runCollection } from "@/core/runner/runner";
import { DEFAULT_SETTINGS, DEFAULT_RUN_OPTIONS, type FolderNode } from "@/core/types";
import { startTestServer } from "./helpers/server";
import { runScript } from "@/core/scripts/sandbox";
import { variableExtensions, variableCompletionSource } from "@/components/editor/variables-ext";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";

const time = Date.parse("2026-10-30T12:00:00Z");
const registry = () => createDynamicVariables({ seed: 47, now: () => time });
afterEach(() => vi.restoreAllMocks());

describe("dynamic variable compatibility", () => {
  it("implements every versioned identifier reproducibly without sharing mutable random state", () => {
    const a = registry(),
      b = registry();
    expect(Object.keys(a).sort()).toEqual([...DYNAMIC_VARIABLE_NAMES].sort());
    for (const name of DYNAMIC_VARIABLE_NAMES) {
      const value = a[name]();
      expect(value, name).toEqual(b[name]());
      expect(typeof value, name).toBe("string");
      expect(value.length, name).toBeGreaterThan(0);
      expect(value, name).not.toContain("undefined");
      expect(value, name).not.toContain("{{");
    }
    expect(a.$guid()).not.toEqual(a.$guid());
    expect(DYNAMIC_MANIFEST.aliases).toEqual({ $randomUUID: "$guid" });
  });
  it("returns the documented numeric, network, identifier and date formats across seeds", () => {
    for (let seed = 0; seed < 100; seed++) {
      const g = createDynamicVariables({ seed, now: () => time });
      expect(g.$guid()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
      expect(g.$randomUUID()).toMatch(/^[\da-f-]{36}$/);
      expect(g.$randomAlphaNumeric()).toMatch(/^[a-z\d]$/i);
      expect(g.$randomHexadecimal()).toMatch(/^[a-f\d]$/);
      expect(g.$randomPassword()).toMatch(/^[a-z\d]{15}$/i);
      expect(g.$randomBoolean()).toMatch(/^(true|false)$/);
      expect(Number(g.$randomInt())).toBeGreaterThanOrEqual(0);
      expect(Number(g.$randomInt())).toBeLessThanOrEqual(1000);
      expect(Number(g.$randomLatitude())).toBeGreaterThanOrEqual(-90);
      expect(Number(g.$randomLatitude())).toBeLessThanOrEqual(90);
      expect(Number(g.$randomLongitude())).toBeGreaterThanOrEqual(-180);
      expect(Number(g.$randomLongitude())).toBeLessThanOrEqual(180);
      expect(isIP(g.$randomIP())).toBe(4);
      expect(isIP(g.$randomIPV6())).toBe(6);
      expect(g.$randomMACAddress()).toMatch(/^[a-f\d]{2}(:[a-f\d]{2}){5}$/i);
      expect(g.$randomHexColor()).toMatch(/^#[a-f\d]{6}$/);
      expect(g.$randomSemver()).toMatch(/^\d+\.\d+\.\d+$/);
      expect(g.$randomProtocol()).toMatch(/^https?$/);
      expect(g.$randomPhoneNumber()).toMatch(/^\d{3}-\d{3}-\d{4}$/);
      expect(g.$randomPhoneNumberExt()).toMatch(/^\d{2}-\d{3}-\d{3}-\d{4}$/);
      expect(g.$randomPrice()).toMatch(/^\d+\.\d{2}$/);
      expect(Number(g.$randomPrice())).toBeGreaterThanOrEqual(0);
      expect(Number(g.$randomPrice())).toBeLessThanOrEqual(1000);
      expect(g.$randomBankAccount()).toMatch(/^\d{8}$/);
      expect(g.$randomCreditCardMask()).toMatch(/^\d{4}$/);
      expect(g.$randomBankAccountBic()).toMatch(/^[A-Z]{6}[A-Z\d]{2}([A-Z\d]{3})?$/);
      const iban = g.$randomBankAccountIban();
      expect(iban).toMatch(/^[A-Z]{2}\d{2}[A-Z\d]{11,27}$/);
      const checksum = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) =>
        String(c.charCodeAt(0) - 55),
      );
      expect(BigInt(checksum) % BigInt(97)).toBe(BigInt(1));
      expect(g.$randomCurrencyCode()).toMatch(/^[A-Z]{3}$/);
      expect(g.$randomCountryCode()).toMatch(/^[A-Z]{2}$/);
      expect(g.$randomLocale()).toMatch(/^[a-z]{2}$/);
      expect(g.$timestamp()).toBe("1793361600");
      expect(g.$isoTimestamp()).toBe("2026-10-30T12:00:00.000Z");
      expect(Date.parse(g.$randomDateFuture())).toBeGreaterThan(time);
      expect(Date.parse(g.$randomDatePast())).toBeLessThan(time);
      expect(Date.parse(g.$randomDateRecent())).toBeGreaterThanOrEqual(time - 7 * 86400000 - 1000);
      expect(Date.parse(g.$randomDateRecent())).toBeLessThanOrEqual(time);
      expect(g.$randomDateFuture()).toContain("GMT");
    }
  });
  it("generates contextual text, safe placeholder image strings and file paths", () => {
    const g = registry();
    expect(g.$randomWeekday()).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/);
    expect(g.$randomMonth()).toMatch(
      /^(January|February|March|April|May|June|July|August|September|October|November|December)$/,
    );
    expect(g.$randomIngverb()).toMatch(/ing$/);
    expect(g.$randomDatabaseType()).toMatch(/^[a-z ]+$/i);
    expect(g.$randomDatabaseCollation()).toContain("_");
    expect(g.$randomUserAgent()).toContain("Mozilla/");
    expect(g.$randomEmail()).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(g.$randomExampleEmail()).toMatch(/@example\.(com|org|net)$/);
    expect(new URL(g.$randomUrl()).protocol).toMatch(/^https?:$/);
    expect(new URL(g.$randomAvatarImage()).hostname).toBe("avatars.githubusercontent.com");
    expect(new URL(g.$randomCatsImage()).pathname).toBe("/640/480/cats");
    expect(decodeURIComponent(g.$randomImageDataUri())).toContain("<svg");
    expect(g.$randomFileName()).toContain(".");
    expect(g.$randomMimeType()).toContain("/");
    expect(g.$randomFilePath()).toMatch(/^\//);
    expect(g.$randomDirectoryPath()).toMatch(/^\//);
    expect(g.$randomLoremSentences().match(/[.!?]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(g.$randomLoremSentences().match(/[.!?]/g)?.length).toBeLessThanOrEqual(6);
    expect(g.$randomLoremParagraphs().split("\n")).toHaveLength(3);
    expect(g.$randomLoremSlug()).toMatch(/^[a-z]+(-[a-z]+)+$/);
    const lines = g.$randomLoremLines().split("\n").length;
    expect(lines).toBeGreaterThanOrEqual(1);
    expect(lines).toBeLessThanOrEqual(5);
  });
  it("keeps case-sensitive unsupported names unresolved and respects local overrides", () => {
    for (const name of ["$notSupported", "$randomIpv6", "toString", "__proto__", "$constructor"]) {
      expect(isDynamicVariable(name)).toBe(false);
      expect(generateDynamic(name)).toBeUndefined();
      expect(resolveTemplate(`{{${name}}}`, emptyScopes()).unresolved).toEqual([name]);
    }
    expect(resolveTemplate("{{$guid}}", { ...emptyScopes(), local: { $guid: "fixed" } }).value).toBe("fixed");
  });
  it("uses the same generators for request interpolation and sandbox replaceIn", async () => {
    const g = registry();
    for (const name of DYNAMIC_VARIABLE_NAMES) vi.spyOn(DYNAMIC_VARIABLES, name).mockReturnValue(g[name]());
    const templates = DYNAMIC_VARIABLE_NAMES.map((name) => `{{${name}}}`);
    const expected = templates.map((text) => resolveTemplate(text, emptyScopes()).value);
    const result = await runScript(
      `pm.variables.set('values', ${JSON.stringify(templates)}.map(s => pm.variables.replaceIn(s)));`,
      {
        scopes: emptyScopes(),
        request: { method: "GET", url: "https://example.test/", headers: [] },
        info: {
          eventName: "prerequest",
          iteration: 0,
          iterationCount: 1,
          requestName: "Dynamic",
          requestId: "dynamic",
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.scopes.local.values)).toEqual(expected);
  });

  it("resolves the catalog through actual collection execution used by the runner and CLI", async () => {
    const server = await startTestServer();
    try {
      const root: FolderNode = {
        kind: "folder",
        id: "dynamic",
        name: "Dynamic",
        auth: { type: "none" },
        headers: [],
        preRequestScript: "",
        testScript: "",
        children: [
          {
            kind: "request",
            id: "echo",
            name: "Echo",
            method: "POST",
            url: server.url + "/echo?account={{$randomBankAccount}}",
            params: [],
            headers: [{ key: "X-Code", value: "{{$randomCountryCode}}", enabled: true }],
            body: { mode: "raw", raw: '{"id":"{{$guid}}"}', language: "json" },
            auth: { type: "none" },
            settings: { ...DEFAULT_SETTINGS },
            preRequestScript:
              "pm.variables.set('replacement', pm.variables.replaceIn('{{$randomBankAccount}}'));",
            testScript:
              "pm.test('account and body', () => { pm.expect(pm.response.json().query.account).to.match(/^[0-9]{8}$/); pm.expect(pm.variables.get('replacement')).to.match(/^[0-9]{8}$/); });",
          },
        ],
      };
      const { summary } = await runCollection({
        root,
        scopes: emptyScopes(),
        options: { ...DEFAULT_RUN_OPTIONS, iterations: 2 },
      });
      expect(summary.status).toBe("passed");
      expect(summary.passedTests).toBe(2);
      for (const request of server.requests) {
        expect(request.headers["x-code"]).toMatch(/^[A-Z]{2}$/);
        expect(JSON.parse(request.body).id).toMatch(/^[a-f0-9-]{36}$/);
      }
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0].body).not.toEqual(server.requests[1].body);
    } finally {
      await server.close();
    }
  });
  it("exposes the entire catalog through editor completion without generator imports", async () => {
    const extensions = variableExtensions({}, { tooltips: false });
    const state = EditorState.create({ doc: "{{$random", extensions });
    const completions = variableCompletionSource({})(new CompletionContext(state, state.doc.length, true));
    expect(completions?.options.map((option) => option.label).sort()).toEqual(
      [...DYNAMIC_VARIABLE_NAMES].sort(),
    );
    expect(completions?.options.find((option) => option.label === "$randomIPV6")?.apply).toBe(
      "$randomIPV6}}",
    );
    expect(
      variableCompletionSource({})(new CompletionContext(EditorState.create({ doc: "text" }), 4, false)),
    ).toBeNull();
  });
});
