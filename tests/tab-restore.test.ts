import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, BodyConfig } from "@/core/types";

// Exercise store actions without browser storage or toast rendering.
vi.mock("zustand/middleware", () => ({ persist: (initializer: unknown) => initializer }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/api", () => ({
  api: {
    workspaces: { list: vi.fn(), tree: vi.fn() },
    environments: { list: vi.fn() },
    variables: { list: vi.fn() },
    requests: { update: vi.fn(), create: vi.fn(), get: vi.fn() },
    proxy: vi.fn(),
  },
}));

import { toast } from "sonner";
import { api, type SavedRequest } from "@/lib/api";
import { containsWithheld, sanitizeRequestDraftForBrowser, WITHHELD } from "@/core/retention";
import { migrateStoredState, newDraft, sanitizeStoredState, snapshot, useApp, type Tab } from "@/stores/app";

type RequestTab = Extract<Tab, { type: "request" }>;

const BASIC: AuthConfig = { type: "basic", basic: { username: "dbuser", password: "16" } };
const LOGIN_BODY: BodyConfig = {
  mode: "raw",
  language: "json",
  raw: '{"username":"dbuser","password":"dbpass"}',
};

function loginDraft(header: string, auth: AuthConfig = { type: "inherit" }) {
  return newDraft({
    id: "login",
    name: "Login",
    method: "POST",
    url: "https://manhattan.test/login",
    folderId: "folder",
    headers: [{ key: "Authorization", value: header, enabled: true }],
    body: LOGIN_BODY,
    auth,
    testScript: 'pm.environment.set("access_token", pm.response.json().access_token);',
  });
}

function storedTab(draft: ReturnType<typeof loginDraft>, edits: Partial<typeof draft> = {}): RequestTab {
  const tab: RequestTab = {
    id: "tab",
    type: "request",
    requestId: "login",
    draft: { ...draft, ...edits },
    saved: snapshot(draft),
    result: null,
  };
  const restored = sanitizeStoredState({ workspaceId: "workspace", tabs: [tab] }).tabs[0];
  if (restored.type !== "request") throw new Error("Expected a request tab");
  return restored;
}

const current = () => useApp.getState().tabs[0] as RequestTab;

beforeEach(() => {
  vi.resetAllMocks();
  useApp.setState({ ...useApp.getInitialState(), workspaceId: "workspace" }, true);
  vi.mocked(api.workspaces.tree).mockResolvedValue({ folders: [], requests: [{ id: "login" } as never] });
  vi.mocked(api.workspaces.list).mockResolvedValue([{ id: "workspace", name: "Workspace" }]);
  vi.mocked(api.environments.list).mockResolvedValue([]);
  vi.mocked(api.variables.list).mockResolvedValue([]);
});

describe("variable references survive browser storage (LAB-295)", () => {
  const auths: [string, AuthConfig][] = [
    ["no auth", { type: "inherit" }],
    ["basic auth whose password occurs in the variable name", BASIC],
    [
      "basic auth whose password is part of the scheme word",
      { type: "basic", basic: { username: "u", password: "auth" } },
    ],
    ["bearer auth with a short token", { type: "bearer", bearer: { token: "vp" } }],
  ];
  for (const [label, auth] of auths)
    for (const header of [
      "{{x}}",
      "Basic {{x}}",
      "Bearer {{x}}",
      "{{basic_auth_16vp}}",
      "Basic {{user}}:{{pass}}",
    ])
      it(`keeps "${header}" with ${label}`, () => {
        const tab = storedTab(loginDraft(header, auth));
        expect(tab.draft.headers[0].value).toBe(header);
      });

  it("keeps a reference with invisible characters pasted around it", () => {
    const header = "​{{basic_auth_16vp}}﻿";
    expect(storedTab(loginDraft(header)).draft.headers[0].value).toBe(header);
  });

  it("keeps references inside scripts, URLs and bodies even when a credential matches their name", () => {
    const draft = newDraft({
      url: "https://x.test/?key={{basic_auth_16vp}}",
      headers: [{ key: "X-Trace", value: "{{basic_auth_16vp}}-16", enabled: true }],
      body: { mode: "raw", language: "json", raw: '{"auth":"{{basic_auth_16vp}}"}' },
      auth: BASIC,
    });
    const safe = sanitizeRequestDraftForBrowser(draft);
    expect(safe.url).toBe("https://x.test/?key={{basic_auth_16vp}}");
    expect(safe.headers[0].value).toBe(`{{basic_auth_16vp}}-${WITHHELD}`);
    expect(safe.body).toMatchObject({ raw: '{"auth":"{{basic_auth_16vp}}"}' });
  });
});

describe("withheld values are marked, never stored as a sendable placeholder (LAB-295)", () => {
  it("marks a literal secret as withheld instead of writing [REDACTED]", () => {
    const tab = storedTab(loginDraft("Basic ZGJ1c2VyOmRicGFzcw=="));
    expect(tab.draft.headers[0].value).toBe(WITHHELD);
    expect(JSON.stringify(tab.draft)).not.toContain("[REDACTED]");
    expect(JSON.stringify(tab.draft)).not.toContain("dbpass");
    expect(containsWithheld(tab.draft)).toBe(true);
  });

  it("refuses to send a request that still holds a withheld value", async () => {
    const tab = storedTab(loginDraft("Basic ZGJ1c2VyOmRicGFzcw=="));
    useApp.setState({ tabs: [{ ...tab, requestId: null, saved: null }] });
    await useApp.getState().sendTab("tab");
    expect(api.proxy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("withheld"));
  });

  it("refuses to save a withheld value over the server copy", async () => {
    const tab = storedTab(loginDraft("{{basic_auth_16vp}}"), { name: "Edited" });
    useApp.setState({ tabs: [tab] });
    expect(containsWithheld(tab.draft.body)).toBe(true);
    expect(await useApp.getState().saveTab("tab")).toBe(false);
    expect(api.requests.update).not.toHaveBeenCalled();
  });

  it("re-reads an unedited saved request from the server on restore", async () => {
    const saved = loginDraft("{{basic_auth_16vp}}", BASIC);
    useApp.setState({ tabs: [storedTab(saved)] });
    vi.mocked(api.requests.get).mockResolvedValue({
      ...saved,
      workspaceId: "workspace",
      sort: 0,
    } as SavedRequest);
    await useApp.getState().init();
    expect(current().draft.headers[0].value).toBe("{{basic_auth_16vp}}");
    expect(current().draft.body).toEqual(LOGIN_BODY);
    expect(current().draft.auth).toEqual(BASIC);
    expect(containsWithheld(current().draft)).toBe(false);
    expect(current().saved).toBe(snapshot(current().draft));
  });

  it("keeps unsaved edits on restore and fills in only the withheld values that did not change", async () => {
    const saved = loginDraft("{{basic_auth_16vp}}");
    useApp.setState({
      tabs: [storedTab(saved, { name: "Edited name", url: "https://manhattan.test/v2/login" })],
    });
    vi.mocked(api.requests.get).mockResolvedValue({
      ...saved,
      workspaceId: "workspace",
      sort: 0,
    } as SavedRequest);
    await useApp.getState().init();
    expect(current().draft.name).toBe("Edited name");
    expect(current().draft.url).toBe("https://manhattan.test/v2/login");
    expect(current().draft.body).toEqual(LOGIN_BODY);
    expect(containsWithheld(current().draft)).toBe(false);
  });

  it("leaves an edited withheld value marked, so it cannot be sent", async () => {
    const saved = loginDraft("{{basic_auth_16vp}}");
    const edited: BodyConfig = {
      mode: "raw",
      language: "json",
      raw: '{"username":"other","password":"newpass"}',
    };
    useApp.setState({ tabs: [storedTab(saved, { body: edited })] });
    vi.mocked(api.requests.get).mockResolvedValue({
      ...saved,
      workspaceId: "workspace",
      sort: 0,
    } as SavedRequest);
    await useApp.getState().init();
    expect(JSON.stringify(current().draft.body)).toContain(WITHHELD);
    expect(JSON.stringify(current().draft.body)).not.toContain("dbpass");
  });

  it("marks placeholders written by the previous storage version so they are restored, not sent", async () => {
    const saved = loginDraft("{{basic_auth_16vp}}");
    const legacyDraft = {
      ...saved,
      headers: [{ key: "Authorization", value: "[REDACTED]", enabled: true }],
      body: { ...LOGIN_BODY, raw: '{"username":"dbuser","password":"[REDACTED]"}' },
    };
    const migrated = migrateStoredState(
      {
        tabs: [
          {
            id: "tab",
            type: "request",
            requestId: "login",
            draft: legacyDraft,
            saved: snapshot(legacyDraft),
          },
        ],
      },
      2,
    );
    const tab = migrated.tabs[0] as RequestTab;
    expect(tab.draft.headers[0].value).toBe(WITHHELD);
    useApp.setState({ tabs: [tab] });
    vi.mocked(api.requests.get).mockResolvedValue({
      ...saved,
      workspaceId: "workspace",
      sort: 0,
    } as SavedRequest);
    await useApp.getState().init();
    expect(current().draft.headers[0].value).toBe("{{basic_auth_16vp}}");
    expect(current().draft.body).toEqual(LOGIN_BODY);
  });
});
