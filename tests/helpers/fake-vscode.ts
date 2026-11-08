/** Just enough of the VS Code extension API for tests/vscode-extension.test.ts. */
export class Disposable {
  constructor(private readonly callOnDispose: () => void = () => undefined) {}
  dispose() {
    this.callOnDispose();
  }
}
export class EventEmitter<T> {
  private listeners: ((value: T) => void)[] = [];
  event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return new Disposable(() => (this.listeners = this.listeners.filter((l) => l !== listener)));
  };
  fire(value: T) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners = [];
  }
}
export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}
  static parse(value: string) {
    const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(value)!;
    return new Uri(match[1], match[2].replace(/^\/\//, "/"));
  }
  static file(path: string) {
    return new Uri("file", path);
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}:${this.path}`;
  }
}
export const FileType = { File: 1, Directory: 2 };
export class FileSystemError extends Error {
  static NoPermissions(message?: string) {
    return new FileSystemError(message ?? "no permissions");
  }
}
export class ThemeIcon {
  constructor(readonly id: string) {}
}
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class TreeItem {
  iconPath?: unknown;
  contextValue?: string;
  description?: string;
  command?: unknown;
  constructor(
    readonly label: string,
    readonly collapsibleState: number,
  ) {}
}
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2 };
export const ViewColumn = { Beside: -2 };
export const ProgressLocation = { Notification: 15 };
export class CancellationTokenSource {
  token = { onCancellationRequested: () => new Disposable() };
  dispose() {}
}

export type PickItem = { label: string; value?: unknown; description?: string };
interface FileSystemLike {
  readFile(uri: Uri): Promise<Uint8Array> | Uint8Array;
  writeFile(uri: Uri, content: Uint8Array): Promise<void> | void;
}
interface ContentProviderLike {
  provideTextDocumentContent(uri: Uri): string | Promise<string>;
}

/** Everything the tests drive or inspect. Reset with `reset()` between tests. */
export const fake = {
  settings: {} as Record<string, unknown>,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  fileSystems: new Map<string, FileSystemLike>(),
  contentProviders: new Map<string, ContentProviderLike>(),
  views: new Map<string, unknown>(),
  folders: [] as { uri: { fsPath: string } }[],
  shown: [] as { scheme: string; text: string }[],
  messages: [] as { level: string; text: string }[],
  inputs: [] as (string | undefined)[],
  picks: [] as ((items: PickItem[]) => PickItem | PickItem[] | undefined)[],
  warnings: [] as (string | undefined)[],
  status: { text: "", shown: false },
  activeEditor: undefined as
    undefined | { document: { uri: Uri; getText(): string; save(): Promise<boolean> } },
  reset() {
    this.settings = {};
    this.commands.clear();
    this.fileSystems.clear();
    this.contentProviders.clear();
    this.views.clear();
    this.folders = [];
    this.shown = [];
    this.messages = [];
    this.inputs = [];
    this.picks = [];
    this.warnings = [];
    this.status = { text: "", shown: false };
    this.activeEditor = undefined;
  },
};

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    fake.commands.set(id, handler);
    return new Disposable();
  },
  executeCommand: async (id: string, ...args: unknown[]) => fake.commands.get(id)?.(...args),
};
export const window = {
  createStatusBarItem: () => ({
    set text(value: string) {
      fake.status.text = value;
    },
    get text() {
      return fake.status.text;
    },
    command: "",
    show: () => (fake.status.shown = true),
    dispose() {},
  }),
  createTreeView(id: string, options: { treeDataProvider: unknown }) {
    fake.views.set(id, options.treeDataProvider);
    return new Disposable();
  },
  showInputBox: async () => fake.inputs.shift(),
  showQuickPick: async (items: PickItem[]) => (fake.picks.shift() ?? ((all: PickItem[]) => all[0]))(items),
  showInformationMessage: async (text: string) => void fake.messages.push({ level: "info", text }),
  showErrorMessage: async (text: string) => void fake.messages.push({ level: "error", text }),
  showWarningMessage: async () => fake.warnings.shift(),
  withProgress: async (_o: unknown, task: (progress: unknown, token: unknown) => Promise<void>) =>
    task({}, { onCancellationRequested: () => new Disposable() }),
  showTextDocument: async (document: { uri: Uri; getText(): string }) => {
    fake.shown.push({ scheme: document.uri.scheme, text: document.getText() });
    return {};
  },
  get activeTextEditor() {
    return fake.activeEditor;
  },
};
export const workspace = {
  getConfiguration: () => ({
    get: (key: string) => fake.settings[key],
    update: async (key: string, value: unknown) => void (fake.settings[key] = value),
  }),
  get workspaceFolders() {
    return fake.folders;
  },
  registerFileSystemProvider(scheme: string, provider: FileSystemLike) {
    fake.fileSystems.set(scheme, provider);
    return new Disposable();
  },
  registerTextDocumentContentProvider(scheme: string, provider: ContentProviderLike) {
    fake.contentProviders.set(scheme, provider);
    return new Disposable();
  },
  async openTextDocument(uri: Uri) {
    const fs = fake.fileSystems.get(uri.scheme);
    const content = fs
      ? Buffer.from(await fs.readFile(uri)).toString("utf8")
      : ((await fake.contentProviders.get(uri.scheme)?.provideTextDocumentContent(uri)) ??
        (await import("node:fs/promises")).readFile(uri.fsPath, "utf8"));
    return { uri, getText: () => content };
  },
};
export type ExtensionContext = never;
