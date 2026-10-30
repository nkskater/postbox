/**
 * Server-side request execution settings (LAB-52): default headers, User-Agent,
 * automatic Accept headers and script limits, with env pins clamped to range.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareRequest } from "@/core/http/prepare";
import { Resolver, emptyScopes } from "@/core/variables/resolver";
import { DEFAULT_SETTINGS, type RequestDef } from "@/core/types";
import { SETTINGS_BY_KEY, resolveSettings, sanitizeSettings, validateSetting } from "@/lib/settings/registry";
import { startTestServer } from "./helpers/server";

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "postbox-exec-")), "e.db");

const request = (headers: RequestDef["headers"] = []): RequestDef => ({
  id: "r",
  name: "r",
  method: "GET",
  url: "https://example.com",
  params: [],
  headers,
  body: { mode: "none" },
  auth: { type: "none" },
  preRequestScript: "",
  testScript: "",
  settings: DEFAULT_SETTINGS,
});
const row = (key: string, value: string, enabled = true) => ({ key, value, enabled });
const header = (headers: [string, string][], name: string) =>
  headers.find(([k]) => k.toLowerCase() === name)?.[1];

describe("request defaults in prepareRequest", () => {
  it("puts default headers below collection, folder and request headers", async () => {
    const folder = {
      id: "f",
      name: "f",
      auth: { type: "inherit" as const },
      headers: [row("X-Folder", "folder"), row("X-Shared", "folder")],
      preRequestScript: "",
      testScript: "",
    };
    const scopes = { ...emptyScopes(), environment: { team: "qa" } };
    const { prepared } = await prepareRequest(
      request([row("x-shared", "request")]),
      [folder],
      new Resolver(scopes),
      undefined,
      {
        defaults: {
          headers: [
            row("X-Default", "{{team}}"),
            row("X-Folder", "default"),
            row("X-Shared", "default"),
            row("X-Off", "1", false),
          ],
        },
      },
    );
    expect(header(prepared.headers, "x-default")).toBe("qa");
    expect(header(prepared.headers, "x-folder")).toBe("folder");
    expect(header(prepared.headers, "x-shared")).toBe("request");
    expect(header(prepared.headers, "x-off")).toBeUndefined();
  });

  it("overrides or drops the User-Agent and automatic Accept headers", async () => {
    const r = new Resolver(emptyScopes());
    const plain = (await prepareRequest(request(), [], r)).prepared.headers;
    expect(header(plain, "user-agent")).toBe("Postbox/0.1");
    expect(header(plain, "accept")).toBe("*/*");

    const custom = (await prepareRequest(request(), [], r, undefined, { defaults: { userAgent: "team/2" } }))
      .prepared.headers;
    expect(header(custom, "user-agent")).toBe("team/2");
    const own = (
      await prepareRequest(request([row("User-Agent", "mine")]), [], r, undefined, {
        defaults: { userAgent: "team/2" },
      })
    ).prepared.headers;
    expect(header(own, "user-agent")).toBe("mine");

    const none = (
      await prepareRequest(request(), [], r, undefined, {
        defaults: { userAgent: "", autoAcceptHeaders: false },
      })
    ).prepared.headers;
    expect(header(none, "user-agent")).toBeUndefined();
    expect(header(none, "accept")).toBeUndefined();
    expect(header(none, "accept-encoding")).toBeUndefined();
  });
});

describe("execution settings registry", () => {
  it("clamps numeric env pins to the allowed range and locks the setting", () => {
    const high = resolveSettings({ "execution.scriptTimeoutMs": 2000 }, { SCRIPT_TIMEOUT_MS: "999999" });
    expect(high.values["execution.scriptTimeoutMs"]).toBe(60000);
    expect(high.envLocked["execution.scriptTimeoutMs"]).toBe("SCRIPT_TIMEOUT_MS");
    const low = resolveSettings({}, { SCRIPT_MEMORY_MB: "1" });
    expect(low.values["execution.scriptMemoryMb"]).toBe(8);
    const junk = resolveSettings({ "execution.scriptTimeoutMs": 2000 }, { SCRIPT_TIMEOUT_MS: "soon" });
    expect(junk.values["execution.scriptTimeoutMs"]).toBe(2000);
    expect(junk.envLocked["execution.scriptTimeoutMs"]).toBeUndefined();
  });

  it("validates User-Agent text and default header rows", () => {
    const ua = SETTINGS_BY_KEY.get("execution.userAgent")!;
    expect(validateSetting(ua, "  bot/1  ")).toBe("bot/1");
    expect(() => validateSetting(ua, "bot\r\nX-Evil: 1")).toThrow(/control characters/);
    const { valid, errors } = sanitizeSettings({
      "execution.defaultHeaders": [{ key: "X-Team", value: "qa" }],
    });
    expect(errors).toEqual([]);
    expect(valid["execution.defaultHeaders"]).toEqual([row("X-Team", "qa")]);
    for (const bad of [[{ key: "bad name", value: "x" }], [{ key: "X", value: "a\nb" }], "X: y"])
      expect(sanitizeSettings({ "execution.defaultHeaders": bad }).errors).toHaveLength(1);
  });
});

describe("server execution paths", () => {
  it("applies saved settings to requests and scripts, and only admins can change them", async () => {
    const settings = await import("@/server/settings");
    const { executionSettings } = await import("@/server/execution-settings");
    const repo = await import("@/server/repo");
    const context = await import("@/server/context");
    const server = await startTestServer();
    try {
      settings.patchSettings({
        "execution.defaultHeaders": [row("X-Team", "qa")],
        "execution.userAgent": "team-bot/3",
        "execution.autoAcceptHeaders": false,
        "execution.scriptTimeoutMs": 300,
      });
      expect(executionSettings({} as NodeJS.ProcessEnv).scriptLimits).toEqual({
        timeoutMs: 300,
        memoryBytes: 32 * 1024 * 1024,
      });

      const ws = repo.createWorkspace("exec");
      const result = await context.runSingleRequest({
        workspaceId: ws.id,
        environmentId: null,
        folderId: null,
        request: { ...request(), url: `${server.url}/echo`, preRequestScript: "while (true) {}" },
        saveHistory: false,
      });
      expect(result.scriptErrors[0]?.message).toContain("time limit of 300 ms");

      const sent = await context.runSingleRequest({
        workspaceId: ws.id,
        environmentId: null,
        folderId: null,
        request: { ...request(), url: `${server.url}/echo` },
        saveHistory: false,
      });
      const echoed = JSON.parse(sent.response!.bodyText).headers;
      expect(echoed["x-team"]).toBe("qa");
      expect(echoed["user-agent"]).toBe("team-bot/3");
      expect(echoed.accept).toBeUndefined();

      // Execution settings apply to everyone, so only administrators may change them.
      const { withCaller } = await import("@/server/access-context");
      const users = await import("@/server/users");
      const member = await users.createUser({ username: "member", password: "password123" });
      const admin = await users.createUser({ username: "boss", password: "password123", isAdmin: true });
      expect(() =>
        withCaller({ kind: "user", user: member, via: "session" }, () =>
          settings.patchSettings({ "execution.userAgent": "evil" }),
        ),
      ).toThrow(/Administrator access required/);
      withCaller({ kind: "user", user: admin, via: "session" }, () =>
        settings.patchSettings({ "execution.userAgent": "admin-set" }),
      );
      expect(executionSettings({} as NodeJS.ProcessEnv).requestDefaults.userAgent).toBe("admin-set");
    } finally {
      await server.close();
    }
  });
});
