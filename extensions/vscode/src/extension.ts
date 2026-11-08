/**
 * Postbox for VS Code: browse and edit collections and environments, send requests and read their tests
 * and responses, against a self-hosted server or in offline mode on repository files. Thin glue over
 * ./bridge, which has no vscode imports and carries the tested logic.
 */
import path from "node:path";
import * as vscode from "vscode";
import { parseDotenv, planDotenvImport, toDotenv, SECRET_NAME } from "./bridge/dotenv";
import { discover, sendOffline, type Discovered, type OfflineNode } from "./bridge/offline";
import { renderResult, summaryOf } from "./bridge/render";
import { ServerBackend } from "./bridge/server";
import type { RequestDef, TreeInfo, ViewResult, WorkspaceInfo } from "./bridge/types";
import { nodeFiles } from "./fs-access";

const TOKEN_KEY = "postbox.token";
const ENV_KEY = "postbox.environment";
const RESULT_SCHEME = "postbox-result";
const FS_SCHEME = "postbox";

type Item =
  | { kind: "workspace"; ws: WorkspaceInfo }
  | { kind: "group"; ws: WorkspaceInfo; group: "collections" | "environments" }
  | { kind: "folder"; ws: WorkspaceInfo; id: string; name: string; tree: TreeInfo }
  | { kind: "request"; ws: WorkspaceInfo; id: string; folderId: string; name: string; method: string }
  | { kind: "environment"; ws: WorkspaceInfo; id: string; name: string }
  | { kind: "offline-group"; group: "collections" | "environments" }
  | { kind: "offline-folder"; dir: string; node: OfflineNode }
  | { kind: "offline-request"; dir: string; node: OfflineNode }
  | { kind: "offline-env"; dir: string; name: string }
  | { kind: "message"; text: string };

export interface Api {
  /** For extension-host tests. */
  tree: PostboxTree;
}

export function activate(context: vscode.ExtensionContext): Api {
  const config = () => vscode.workspace.getConfiguration("postbox");
  const mode = () => (config().get<string>("mode") === "offline" ? "offline" : "server");
  const rootDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const results = new Map<string, string>();
  const resultEvents = new vscode.EventEmitter<vscode.Uri>();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "postbox.selectEnvironment";
  context.subscriptions.push(status, resultEvents);

  const backend = async () => {
    const token = (await context.secrets.get(TOKEN_KEY)) ?? null;
    return new ServerBackend({
      baseUrl: config().get<string>("serverUrl") || "http://localhost:3000",
      token,
    });
  };
  const activeEnvironment = () => context.workspaceState.get<string>(ENV_KEY) ?? null;
  const fail = (error: unknown) => {
    void vscode.window.showErrorMessage(`Postbox: ${error instanceof Error ? error.message : String(error)}`);
  };
  const guard =
    <A extends unknown[]>(work: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      try {
        await work(...args);
      } catch (error) {
        fail(error);
      }
    };

  // ----------------------------------------------------------------- virtual documents (server mode)
  const emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const fsProvider: vscode.FileSystemProvider = {
    onDidChangeFile: emitter.event,
    watch: () => new vscode.Disposable(() => undefined),
    stat: () => ({ type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: 0 }),
    readDirectory: () => [],
    createDirectory: () => {
      throw vscode.FileSystemError.NoPermissions("Create items in the Postbox app");
    },
    delete: () => {
      throw vscode.FileSystemError.NoPermissions("Delete items in the Postbox app");
    },
    rename: () => {
      throw vscode.FileSystemError.NoPermissions("Rename items in the Postbox app");
    },
    async readFile(uri) {
      const [, , kind, file] = uri.path.split("/");
      const id = file.replace(/\..*$/, "");
      const api = await backend();
      const value = kind === "environment" ? await api.getEnvironment(id) : await api.getRequest(id);
      const { workspaceId: _w, folderId: _f, ...doc } = value as unknown as Record<string, unknown>;
      return Buffer.from(JSON.stringify(doc, null, 2) + "\n");
    },
    async writeFile(uri, content) {
      const [, , kind, file] = uri.path.split("/");
      const id = file.replace(/\..*$/, "");
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(Buffer.from(content).toString("utf8"));
      } catch (error) {
        throw vscode.FileSystemError.NoPermissions(`Not valid JSON: ${(error as Error).message}`);
      }
      const api = await backend();
      if (kind === "environment")
        await api.saveEnvironment(id, { name: doc.name as string, variables: doc.variables as never });
      else await api.saveRequest(id, doc as Partial<RequestDef>);
      tree.refresh();
    },
  };

  // ----------------------------------------------------------------- results
  const resultProvider: vscode.TextDocumentContentProvider = {
    onDidChange: resultEvents.event,
    provideTextDocumentContent: (uri) => results.get(uri.path) ?? "",
  };
  const showResult = async (result: ViewResult) => {
    const uri = vscode.Uri.parse(`${RESULT_SCHEME}:/response.md`);
    results.set(uri.path, renderResult(result));
    resultEvents.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    });
    status.text = `$(zap) ${summaryOf(result)}`;
    status.show();
  };

  // ----------------------------------------------------------------- tree
  const tree = new PostboxTree(context, backend, mode, rootDir, fail);
  context.subscriptions.push(
    vscode.window.createTreeView("postbox.explorer", { treeDataProvider: tree }),
    vscode.workspace.registerFileSystemProvider(FS_SCHEME, fsProvider, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(RESULT_SCHEME, resultProvider),
  );

  // ----------------------------------------------------------------- commands
  const command = (id: string, run: (...args: never[]) => Promise<void> | void) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(
        id,
        guard(async (...args: unknown[]) => void (await run(...(args as never[])))),
      ),
    );

  command("postbox.refresh", () => tree.refresh());
  command("postbox.setToken", async () => {
    const token = await vscode.window.showInputBox({
      title: "Postbox API token",
      prompt: "Create one on your Postbox profile page. It is kept in VS Code's secret storage.",
      password: true,
      ignoreFocusOut: true,
    });
    if (token === undefined) return;
    if (token) await context.secrets.store(TOKEN_KEY, token.trim());
    else await context.secrets.delete(TOKEN_KEY);
    tree.refresh();
  });
  command("postbox.setServer", async () => {
    const value = await vscode.window.showInputBox({
      title: "Postbox server URL",
      value: config().get<string>("serverUrl"),
      ignoreFocusOut: true,
    });
    if (!value) return;
    await config().update("serverUrl", value, vscode.ConfigurationTarget.Global);
    tree.refresh();
  });
  command("postbox.switchMode", async () => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Server", description: "Use a self-hosted Postbox server", value: "server" },
        { label: "Offline", description: "Work on repository files in this folder", value: "offline" },
      ],
      { title: "Postbox mode" },
    );
    if (!pick) return;
    await config().update("mode", pick.value, vscode.ConfigurationTarget.Workspace);
    tree.refresh();
  });
  command("postbox.openItem", async (item: Item) => {
    if (item.kind === "request" || item.kind === "environment") {
      const uri = vscode.Uri.parse(`${FS_SCHEME}:/${item.ws.id}/${item.kind}/${item.id}.${item.kind}.json`);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    } else if (item.kind === "offline-request") {
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(
          vscode.Uri.file(path.join(rootDir(), item.dir, item.node.file ?? "")),
        ),
      );
    } else if (item.kind === "offline-env") {
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(
          vscode.Uri.file(path.join(rootDir(), item.dir, "variables.json")),
        ),
      );
    }
  });
  command("postbox.selectEnvironment", async () => {
    if (mode() === "offline") {
      const found = await tree.discovered();
      const pick = await vscode.window.showQuickPick(
        [
          { label: "No environment", value: "" },
          ...found.environments.map((env) => ({ label: env.name, description: env.dir, value: env.dir })),
        ],
        { title: "Active environment" },
      );
      if (pick) await context.workspaceState.update(ENV_KEY, pick.value || null);
    } else {
      const api = await backend();
      const out: { label: string; description?: string; value: string }[] = [
        { label: "No environment", value: "" },
      ];
      for (const ws of await api.workspaces())
        for (const env of await api.environments(ws.id))
          out.push({ label: env.name, description: ws.name, value: env.id });
      const pick = await vscode.window.showQuickPick(out, { title: "Active environment" });
      if (pick) await context.workspaceState.update(ENV_KEY, pick.value || null);
    }
    status.text = `$(globe) Postbox: ${activeEnvironment() ? "environment set" : "no environment"}`;
    status.show();
  });
  command("postbox.send", async (item?: Item) => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Postbox: sending…", cancellable: true },
      async (_p, cancel) => {
        const controller = new AbortController();
        cancel.onCancellationRequested(() => controller.abort());
        const editor = vscode.window.activeTextEditor;
        if (mode() === "offline") {
          const target =
            item?.kind === "offline-request"
              ? item
              : offlineTargetOf(editor?.document.uri, await tree.discovered(), rootDir());
          if (!target)
            throw new Error("Select a request in the Postbox view, or open a *.request.json file.");
          await editor?.document.save();
          const local = parseDotenvFile(config().get<string>("dotenvPath"), rootDir());
          const result = await sendOffline(nodeFiles, rootDir(), {
            collectionDir: target.dir,
            requestId: target.node.id,
            environmentDir: activeEnvironment() ?? undefined,
            localVariables: await local,
            allowHosts: config().get<string[]>("allowHosts") ?? [],
            denyHosts: config().get<string[]>("denyHosts") ?? [],
            signal: controller.signal,
          });
          await showResult(result);
          return;
        }
        const api = await backend();
        let request: RequestDef;
        let ws: string;
        let folderId: string | null = null;
        let requestId: string | null = null;
        if (item?.kind === "request") {
          const saved = await api.getRequest(item.id);
          request = saved;
          ws = item.ws.id;
          folderId = item.folderId;
          requestId = item.id;
        } else if (
          editor?.document.uri.scheme === FS_SCHEME &&
          editor.document.uri.path.includes("/request/")
        ) {
          const [, wsId, , file] = editor.document.uri.path.split("/");
          request = JSON.parse(editor.document.getText()) as RequestDef;
          ws = wsId;
          requestId = file.replace(/\..*$/, "");
          folderId = (await api.getRequest(requestId)).folderId;
        } else throw new Error("Select a request in the Postbox view, or open one from it.");
        await showResult(
          await api.send(
            request,
            { workspaceId: ws, environmentId: activeEnvironment(), folderId, requestId },
            controller.signal,
          ),
        );
      },
    );
  });

  // ----------------------------------------------------------------- .env
  const dotenvFile = async () => {
    const configured = config().get<string>("dotenvPath") || ".env";
    return path.isAbsolute(configured) ? configured : path.join(rootDir(), configured);
  };
  command("postbox.importDotenv", async (item?: Item) => {
    const fs = await import("node:fs/promises");
    const text = await fs.readFile(await dotenvFile(), "utf8").catch(() => {
      throw new Error(
        `No .env file at ${config().get<string>("dotenvPath") || ".env"}. Set postbox.dotenvPath.`,
      );
    });
    const entries = parseDotenv(text);
    if (!entries.length) throw new Error("The .env file has no variables.");
    const picked = await vscode.window.showQuickPick(
      entries.map((entry) => ({
        label: entry.key,
        description: SECRET_NAME.test(entry.key) ? "secret" : "",
        picked: true,
      })),
      { canPickMany: true, title: "Variables to import (names that look secret are marked)" },
    );
    if (!picked?.length) return;
    const secretPick = picked.some((p) => p.description === "secret")
      ? await vscode.window.showQuickPick(
          [
            { label: "Create secret variables without their values", value: false },
            { label: "Import secret values too (they are stored in Postbox)", value: true },
          ],
          { title: "Secret values" },
        )
      : { value: false };
    if (!secretPick) return;
    const only = picked.map((p) => p.label);
    if (mode() === "offline")
      throw new Error(
        "In offline mode secrets stay in .env: the extension reads it when you send. Nothing to import.",
      );
    const api = await backend();
    const target = item?.kind === "environment" ? item : await pickEnvironment(api);
    if (!target) return;
    const current = await api.getEnvironment(target.id);
    const plan = planDotenvImport(current.variables, entries, {
      only,
      includeSecretValues: secretPick.value,
    });
    await api.saveEnvironment(target.id, { variables: plan.variables });
    tree.refresh();
    void vscode.window.showInformationMessage(
      `Postbox: ${plan.added.length} added, ${plan.updated.length} updated, ${plan.unchanged.length} unchanged${plan.withheld.length ? `; ${plan.withheld.length} secret value(s) not imported` : ""}.`,
    );
  });
  command("postbox.exportDotenv", async (item?: Item) => {
    const api = await backend();
    const target = item?.kind === "environment" ? item : await pickEnvironment(api);
    if (!target) return;
    const env = await api.getEnvironment(target.id);
    const withSecrets = env.variables.some((v) => v.type === "secret")
      ? await vscode.window.showWarningMessage(
          "Write secret values to the .env file too?",
          { modal: true },
          "Include secrets",
          "Skip secrets",
        )
      : "Skip secrets";
    if (!withSecrets) return;
    const out = toDotenv(env.variables, { includeSecrets: withSecrets === "Include secrets" });
    const fs = await import("node:fs/promises");
    await fs.writeFile(await dotenvFile(), out.text, { mode: 0o600 });
    void vscode.window.showInformationMessage(
      `Postbox: wrote ${await dotenvFile()}${out.omitted.length ? ` (left out ${out.omitted.length} secret(s))` : ""}. Keep it out of Git.`,
    );
  });

  async function pickEnvironment(api: ServerBackend) {
    const out: { label: string; description: string; ws: WorkspaceInfo; id: string; name: string }[] = [];
    for (const ws of await api.workspaces())
      for (const env of await api.environments(ws.id))
        out.push({ label: env.name, description: ws.name, ws, id: env.id, name: env.name });
    const pick = await vscode.window.showQuickPick(out, { title: "Environment" });
    return pick ? { kind: "environment" as const, ws: pick.ws, id: pick.id, name: pick.name } : undefined;
  }

  void vscode.commands.executeCommand("setContext", "postbox.offline", mode() === "offline");
  return { tree };
}

async function parseDotenvFile(
  configured: string | undefined,
  root: string,
): Promise<Record<string, string>> {
  const fs = await import("node:fs/promises");
  const file = path.isAbsolute(configured || ".env") ? configured! : path.join(root, configured || ".env");
  try {
    return Object.fromEntries(
      parseDotenv(await fs.readFile(file, "utf8")).map((entry) => [entry.key, entry.value]),
    );
  } catch {
    return {};
  }
}

function offlineTargetOf(uri: vscode.Uri | undefined, found: Discovered, root: string) {
  if (!uri || uri.scheme !== "file") return undefined;
  const wanted = path.normalize(uri.fsPath);
  const walk = (dir: string, node: OfflineNode): { dir: string; node: OfflineNode } | undefined => {
    if (node.kind === "request" && node.file && path.normalize(path.join(root, dir, node.file)) === wanted)
      return { dir, node };
    for (const child of node.children) {
      const hit = walk(dir, child);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const collection of found.collections) {
    const hit = walk(collection.dir, collection.root);
    if (hit) return hit;
  }
  return undefined;
}

export class PostboxTree implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private cache: Discovered | null = null;
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: () => Promise<ServerBackend>,
    private readonly mode: () => "server" | "offline",
    private readonly root: () => string,
    private readonly fail: (error: unknown) => void,
  ) {}
  refresh() {
    this.cache = null;
    this.changed.fire(undefined);
  }
  async discovered() {
    return (this.cache ??= await discover(nodeFiles, this.root()));
  }
  getTreeItem(item: Item): vscode.TreeItem {
    const make = (label: string, state: vscode.TreeItemCollapsibleState, icon?: string, context?: string) => {
      const treeItem = new vscode.TreeItem(label, state);
      if (icon) treeItem.iconPath = new vscode.ThemeIcon(icon);
      treeItem.contextValue = context ?? item.kind;
      return treeItem;
    };
    const { Collapsed, None } = vscode.TreeItemCollapsibleState;
    switch (item.kind) {
      case "workspace":
        return make(item.ws.name, Collapsed, "briefcase");
      case "group":
      case "offline-group":
        return make(
          item.group === "collections" ? "Collections" : "Environments",
          Collapsed,
          item.group === "collections" ? "folder-library" : "symbol-variable",
        );
      case "folder":
        return make(item.name, Collapsed, "folder");
      case "offline-folder":
        return make(item.node.name, Collapsed, "folder");
      case "request":
      case "offline-request": {
        const node = item.kind === "request" ? item : { name: item.node.name, method: item.node.method };
        const treeItem = make(node.name, None, "symbol-method");
        treeItem.description = node.method;
        treeItem.command = { command: "postbox.openItem", title: "Open", arguments: [item] };
        return treeItem;
      }
      case "environment":
      case "offline-env": {
        const treeItem = make(item.name, None, "symbol-variable");
        treeItem.command = { command: "postbox.openItem", title: "Open", arguments: [item] };
        return treeItem;
      }
      default:
        return make(item.text, None, "info", "message");
    }
  }
  async getChildren(item?: Item): Promise<Item[]> {
    try {
      return this.mode() === "offline" ? await this.offlineChildren(item) : await this.serverChildren(item);
    } catch (error) {
      this.fail(error);
      return [{ kind: "message", text: error instanceof Error ? error.message : "Could not load" }];
    }
  }
  private async serverChildren(item?: Item): Promise<Item[]> {
    const api = await this.backend();
    if (!item) {
      const workspaces = await api.workspaces();
      return workspaces.length
        ? workspaces.map((ws) => ({ kind: "workspace" as const, ws }))
        : [{ kind: "message", text: "No workspaces" }];
    }
    if (item.kind === "workspace")
      return [
        { kind: "group", ws: item.ws, group: "collections" },
        { kind: "group", ws: item.ws, group: "environments" },
      ];
    if (item.kind === "group" && item.group === "environments")
      return (await api.environments(item.ws.id)).map((env) => ({
        kind: "environment" as const,
        ws: item.ws,
        id: env.id,
        name: env.name,
      }));
    const tree = item.kind === "folder" ? item.tree : await api.tree(item.kind === "group" ? item.ws.id : "");
    const parent = item.kind === "folder" ? item.id : null;
    const ws = item.kind === "group" || item.kind === "folder" ? item.ws : undefined;
    if (!ws) return [];
    return [
      ...tree.folders
        .filter((f) => f.parentId === parent)
        .map((f) => ({ kind: "folder" as const, ws, id: f.id, name: f.name, tree })),
      ...tree.requests
        .filter((r) => (parent ? r.folderId === parent : false))
        .map((r) => ({
          kind: "request" as const,
          ws,
          id: r.id,
          folderId: r.folderId,
          name: r.name,
          method: r.method,
        })),
    ];
  }
  private async offlineChildren(item?: Item): Promise<Item[]> {
    const found = await this.discovered();
    if (!item) {
      if (!found.collections.length && !found.environments.length)
        return [
          {
            kind: "message",
            text: found.problems[0]?.message ?? "No collection.json or environment.json found in this folder",
          },
        ];
      return [
        { kind: "offline-group", group: "collections" },
        { kind: "offline-group", group: "environments" },
      ];
    }
    if (item.kind === "offline-group" && item.group === "environments")
      return found.environments.map((env) => ({
        kind: "offline-env" as const,
        dir: env.dir,
        name: env.name,
      }));
    if (item.kind === "offline-group")
      return found.collections.map((c) => ({ kind: "offline-folder" as const, dir: c.dir, node: c.root }));
    if (item.kind === "offline-folder")
      return item.node.children.map((node) => ({
        kind: node.kind === "folder" ? ("offline-folder" as const) : ("offline-request" as const),
        dir: item.dir,
        node,
      }));
    return [];
  }
}

export function deactivate() {}
