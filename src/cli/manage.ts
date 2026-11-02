import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError } from "commander";
import { ApiClient } from "./client";
import { CliError, EXIT } from "./errors";
import { column, defaultFormat, printItem, printList, type Column, type Format } from "./output";
import {
  loadStore,
  maskToken,
  normalizeServerUrl,
  resolveConnection,
  saveStore,
  type Profile,
} from "./profiles";

type Row = Record<string, unknown>;
interface Globals {
  profile?: string;
  url?: string;
  token?: string;
  output?: Format;
  yes?: boolean;
  limit?: number;
  offset?: number;
  workspace?: string;
}
interface Ctx {
  api: ApiClient;
  format: Format;
  opts: Globals & Record<string, unknown>;
  workspace(): Promise<string>;
  confirm(message: string): Promise<void>;
  list(rows: Row[], columns: Column[]): void;
  show(value: unknown): void;
}

const out = (text: string) => process.stdout.write(text + "\n");

function count(min: number) {
  return (value: string) => {
    if (!/^\d+$/.test(value) || Number(value) < min || !Number.isSafeInteger(Number(value)))
      throw new InvalidArgumentError(`Expected an integer of at least ${min}.`);
    return Number(value);
  };
}

/** Raw JSON from a file, or stdin for "-". */
async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = file === "-" ? await readStdin() : await readFile(file, "utf8");
  } catch (error) {
    throw new CliError(`Cannot read ${file}: ${(error as Error).message}`, EXIT.usage);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new CliError(`${file} is not valid JSON: ${(error as Error).message}`, EXIT.usage);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function jsonObject(value: unknown, what: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError(`${what} must be a JSON object.`, EXIT.usage);
  return value as Row;
}

function jsonArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new CliError(`${what} must be a JSON array.`, EXIT.usage);
  return value;
}

async function makeCtx(command: Command): Promise<Ctx> {
  const opts = command.optsWithGlobals<Globals & Record<string, unknown>>();
  const connection = await resolveConnection(opts);
  const format = opts.output ?? defaultFormat();
  const api = new ApiClient(connection.url, connection.token);
  return {
    api,
    format,
    opts,
    async workspace() {
      const given = opts.workspace || process.env.POSTBOX_WORKSPACE;
      if (given) return given;
      const all = await api.request<Row[]>("GET", "/api/workspaces");
      if (all.length === 1) return String(all[0].id);
      throw new CliError(
        "Choose a workspace with --workspace <id> or POSTBOX_WORKSPACE (see `postbox workspace list`).",
        EXIT.usage,
      );
    },
    async confirm(message) {
      if (opts.yes) return;
      if (!process.stdin.isTTY || !process.stderr.isTTY)
        throw new CliError(`${message} Pass --yes to confirm in non-interactive use.`, EXIT.usage);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") throw new CliError("Cancelled.", EXIT.failure);
      } finally {
        rl.close();
      }
    },
    list: (rows, columns) =>
      printList(format, rows, columns, { limit: opts.limit, offset: opts.offset ?? 0 }),
    show: (value) => printItem(format, value),
  };
}

type Action = (ctx: Ctx, args: string[], command: Command) => Promise<void>;
/** Commander passes positionals, then options, then the command. */
const act =
  (fn: Action) =>
  async (...raw: unknown[]) => {
    const command = raw[raw.length - 1] as Command;
    const args = raw.slice(0, -2).filter((value): value is string => typeof value === "string");
    await fn(await makeCtx(command), args, command);
  };

/** Subcommand groups report usage mistakes through the stable exit codes. */
function group(parent: Command, name: string, description: string): Command {
  const command = parent.command(name).description(description);
  command.exitOverride();
  return command;
}

function withList(command: Command) {
  return command
    .option("--limit <n>", "Return at most this many items", count(1))
    .option("--offset <n>", "Skip this many items", count(0));
}
const withWorkspace = (command: Command) =>
  command.option("-w, --workspace <id>", "Workspace id (or POSTBOX_WORKSPACE)");

const id = column("ID", "id");
const name = column("NAME", "name");
const folderColumns = [id, name, column("PARENT", "parentId")];

async function writeOutput(text: string, file?: string) {
  if (file) {
    await writeFile(file, text);
    console.error(`Wrote ${file}`);
  } else process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

export function registerManagement(program: Command) {
  program
    .option("--profile <name>", "Server profile to use (or POSTBOX_PROFILE)")
    .option("--url <url>", "Server URL (or POSTBOX_URL); overrides the profile")
    .option(
      "--token <token>",
      "API token (prefer POSTBOX_TOKEN or a profile; arguments are visible to others)",
    )
    .option(
      "-o, --output <format>",
      "json or table (default: table in a terminal, json when piped)",
      (value) => {
        if (value !== "json" && value !== "table") throw new InvalidArgumentError("Use json or table.");
        return value as Format;
      },
    )
    .option("-y, --yes", "Confirm destructive actions without prompting")
    .addHelpText(
      "after",
      "\nManagement commands talk to a running Postbox server over its REST API.\n" +
        "Exit codes: 0 ok, 1 failed, 2 usage, 3 auth, 4 not found, 5 rejected, 6 rate/quota limited, 7 server error, 8 unreachable.",
    );

  // ------------------------------------------------------------ profiles
  const profile = group(
    program,
    "profile",
    "Manage saved server profiles (stored in your user config, mode 0600)",
  );
  profile
    .command("add <name> <url>")
    .description("Save a server profile; store a token with the global --token, --token-stdin or --token-env")
    .option("--token-stdin", "Read the token from standard input")
    .option(
      "--token-env <variable>",
      "Read the token from this environment variable at use time instead of storing it",
    )
    .option("--default", "Make this the current profile")
    .action(async (profileName: string, serverUrl: string, options: Record<string, unknown>) => {
      if (!/^[\w.-]{1,64}$/.test(profileName))
        throw new CliError("Profile names use letters, digits, dot, dash and underscore.", EXIT.usage);
      const token = program.opts<Globals>().token;
      const given = [token, options.tokenStdin, options.tokenEnv].filter(Boolean).length;
      if (given > 1)
        throw new CliError("Use only one of --token, --token-stdin and --token-env.", EXIT.usage);
      const entry: Profile = { url: normalizeServerUrl(serverUrl) };
      if (options.tokenStdin) entry.token = (await readStdin()).trim();
      else if (token) entry.token = token;
      else if (options.tokenEnv) entry.tokenEnv = String(options.tokenEnv);
      const store = await loadStore();
      store.profiles[profileName] = entry;
      if (options.default || !store.current) store.current = profileName;
      await saveStore(store);
      out(`Saved profile ${profileName}${store.current === profileName ? " (current)" : ""}`);
    });
  profile
    .command("list")
    .description("List saved profiles")
    .action(async () => {
      const store = await loadStore();
      const rows = Object.entries(store.profiles).map(([key, value]) => ({
        name: key,
        url: value.url,
        token: value.tokenEnv ? `$${value.tokenEnv}` : maskToken(value.token),
        current: store.current === key,
      }));
      printList(
        program.opts<Globals>().output ?? defaultFormat(),
        rows,
        [
          column("NAME", "name"),
          column("URL", "url"),
          column("TOKEN", "token"),
          column("CURRENT", "current"),
        ],
        { offset: 0 },
      );
    });
  profile
    .command("use <name>")
    .description("Make a profile current")
    .action(async (profileName: string) => {
      const store = await loadStore();
      if (!store.profiles[profileName]) throw new CliError(`No profile named "${profileName}".`, EXIT.usage);
      store.current = profileName;
      await saveStore(store);
      out(`Using profile ${profileName}`);
    });
  profile
    .command("remove <name>")
    .description("Delete a saved profile")
    .action(async (profileName: string) => {
      const store = await loadStore();
      if (!store.profiles[profileName]) throw new CliError(`No profile named "${profileName}".`, EXIT.usage);
      delete store.profiles[profileName];
      if (store.current === profileName) store.current = undefined;
      await saveStore(store);
      out(`Removed profile ${profileName}`);
    });

  // ------------------------------------------------------------ workspaces
  const workspace = group(program, "workspace", "Manage workspaces");
  withList(workspace.command("list").description("List workspaces")).action(
    act(async (ctx) => ctx.list(await ctx.api.request<Row[]>("GET", "/api/workspaces"), [id, name])),
  );
  workspace
    .command("get <id>")
    .description("Show a workspace")
    .action(
      act(async (ctx, [workspaceId]) => {
        const found = (await ctx.api.request<Row[]>("GET", "/api/workspaces")).find(
          (w) => w.id === workspaceId,
        );
        if (!found) throw new CliError(`Workspace ${workspaceId} not found.`, EXIT.notFound);
        ctx.show(found);
      }),
    );
  workspace
    .command("create <name>")
    .description("Create a workspace")
    .action(
      act(async (ctx, [workspaceName]) =>
        ctx.show(await ctx.api.request("POST", "/api/workspaces", { body: { name: workspaceName } })),
      ),
    );
  workspace
    .command("rename <id> <name>")
    .description("Rename a workspace")
    .action(
      act(async (ctx, [workspaceId, workspaceName]) =>
        ctx.show(
          await ctx.api.request("PATCH", `/api/workspaces/${enc(workspaceId)}`, {
            body: { name: workspaceName },
          }),
        ),
      ),
    );
  workspace
    .command("delete <id>")
    .description("Delete a workspace and everything in it")
    .action(
      act(async (ctx, [workspaceId]) => {
        await ctx.confirm(`Delete workspace ${workspaceId} and all of its contents?`);
        await ctx.api.request("DELETE", `/api/workspaces/${enc(workspaceId)}`);
        out(`Deleted workspace ${workspaceId}`);
      }),
    );

  // ------------------------------------------------------------ collections
  const collection = group(program, "collection", "Manage collections (top-level folders)");
  withWorkspace(withList(collection.command("list").description("List collections"))).action(
    act(async (ctx) => {
      const tree = await ctx.api.request<{ folders: Row[] }>(
        "GET",
        `/api/workspaces/${enc(await ctx.workspace())}/tree`,
      );
      ctx.list(
        tree.folders.filter((folder) => !folder.parentId),
        [id, name],
      );
    }),
  );
  collection
    .command("get <id>")
    .description("Show a collection with its variables")
    .action(
      act(async (ctx, [folderId]) => ctx.show(await ctx.api.request("GET", `/api/folders/${enc(folderId)}`))),
    );
  withWorkspace(collection.command("create <name>").description("Create a collection")).action(
    act(async (ctx, [collectionName]) =>
      ctx.show(
        await ctx.api.request("POST", "/api/folders", {
          body: { workspaceId: await ctx.workspace(), parentId: null, name: collectionName },
        }),
      ),
    ),
  );
  for (const [kind, parent] of [
    ["collection", collection],
    ["folder", null],
  ] as const) {
    const target = parent ?? group(program, "folder", "Manage folders inside collections");
    if (!parent) {
      withWorkspace(withList(target.command("list").description("List folders"))).action(
        act(async (ctx) => {
          const tree = await ctx.api.request<{ folders: Row[] }>(
            "GET",
            `/api/workspaces/${enc(await ctx.workspace())}/tree`,
          );
          ctx.list(
            tree.folders.filter((folder) => folder.parentId),
            folderColumns,
          );
        }),
      );
      withWorkspace(
        target
          .command("create <name>")
          .description("Create a folder")
          .requiredOption("--parent <id>", "Parent collection or folder"),
      ).action(
        act(async (ctx, [folderName], command) =>
          ctx.show(
            await ctx.api.request("POST", "/api/folders", {
              body: {
                workspaceId: await ctx.workspace(),
                parentId: command.opts<{ parent: string }>().parent,
                name: folderName,
              },
            }),
          ),
        ),
      );
    }
    target
      .command("rename <id> <name>")
      .description(`Rename a ${kind}`)
      .action(
        act(async (ctx, [folderId, newName]) =>
          ctx.show(
            await ctx.api.request("PATCH", `/api/folders/${enc(folderId)}`, { body: { name: newName } }),
          ),
        ),
      );
    target
      .command("duplicate <id>")
      .description(`Duplicate a ${kind}`)
      .action(
        act(async (ctx, [folderId]) =>
          ctx.show(await ctx.api.request("POST", `/api/folders/${enc(folderId)}/duplicate`)),
        ),
      );
    target
      .command("delete <id>")
      .description(`Delete a ${kind} and its contents`)
      .action(
        act(async (ctx, [folderId]) => {
          await ctx.confirm(`Delete ${kind} ${folderId} and everything inside it?`);
          await ctx.api.request("DELETE", `/api/folders/${enc(folderId)}`);
          out(`Deleted ${kind} ${folderId}`);
        }),
      );
  }
  collection
    .command("export <id>")
    .description("Export a collection as Postman JSON (v2.1 by default, or v3)")
    .option("--format <format>", "Postman collection format: v2.1 or v3", "v2.1")
    .option("--out <file>", "Write to a file instead of standard output")
    .option("--include-secrets", "Include secret variable values")
    .option("--include-credentials", "Include request credentials")
    .action(
      act(async (ctx, [folderId], command) => {
        const options = command.opts<{
          out?: string;
          format?: string;
          includeSecrets?: boolean;
          includeCredentials?: boolean;
        }>();
        if (options.format !== "v2.1" && options.format !== "v3")
          throw new CliError("Use --format v2.1 or --format v3", EXIT.usage);
        if (options.format === "v3") {
          const report = await ctx.api.request<{
            collection: unknown;
            diagnostics: { level: string; path: string; message: string }[];
          }>("GET", `/api/export/collection/${enc(folderId)}`, {
            query: {
              format: "v3",
              report: "1",
              includeSecrets: options.includeSecrets ? "1" : undefined,
              includeCredentials: options.includeCredentials ? "1" : undefined,
            },
          });
          for (const note of report.diagnostics)
            process.stderr.write(`note: ${note.path}: ${note.message}\n`);
          await writeOutput(JSON.stringify(report.collection, null, 2) + "\n", options.out);
          return;
        }
        const text = await ctx.api.request<string>("GET", `/api/export/collection/${enc(folderId)}`, {
          raw: true,
          query: {
            includeSecrets: options.includeSecrets ? "1" : undefined,
            includeCredentials: options.includeCredentials ? "1" : undefined,
          },
        });
        await writeOutput(text, options.out);
      }),
    );

  withWorkspace(
    program
      .command("import <file>")
      .description("Import a Postman collection, HAR, OpenAPI or other supported file into a workspace")
      .option("--include-credentials", "Keep recognized credentials")
      .option("--preview", "Report what an OpenAPI or SoapUI import would create without saving"),
  ).action(
    act(async (ctx, [file], command) => {
      const options = command.opts<{ includeCredentials?: boolean; preview?: boolean }>();
      let content: string;
      try {
        content = (await readFile(file, "utf8")).replace(/^﻿/, "");
      } catch (error) {
        throw new CliError(`Cannot read ${file}: ${(error as Error).message}`, EXIT.usage);
      }
      ctx.show(
        await ctx.api.request("POST", "/api/import", {
          body: {
            workspaceId: await ctx.workspace(),
            content,
            ...(options.includeCredentials ? { includeCredentials: true } : {}),
            ...(options.preview ? { preview: true } : {}),
          },
        }),
      );
    }),
  );

  // ------------------------------------------------------------ requests
  const request = group(program, "request", "Manage requests");
  withWorkspace(
    withList(
      request
        .command("list")
        .description("List requests")
        .option("--folder <id>", "Only requests directly in this folder"),
    ),
  ).action(
    act(async (ctx, _args, command) => {
      const tree = await ctx.api.request<{ requests: Row[] }>(
        "GET",
        `/api/workspaces/${enc(await ctx.workspace())}/tree`,
      );
      const folder = command.opts<{ folder?: string }>().folder;
      ctx.list(
        tree.requests.filter((item) => !folder || item.folderId === folder),
        [id, column("METHOD", "method"), name, column("FOLDER", "folderId")],
      );
    }),
  );
  request
    .command("get <id>")
    .description("Show a request definition")
    .action(
      act(async (ctx, [requestId]) =>
        ctx.show(await ctx.api.request("GET", `/api/requests/${enc(requestId)}`)),
      ),
    );
  withWorkspace(
    request
      .command("create")
      .description("Create a request from a JSON definition (a subset is fine: name, method, url, …)")
      .requiredOption("--folder <id>", "Folder or collection to create it in")
      .option("-f, --file <path>", 'JSON request definition, or "-" for standard input'),
  ).action(
    act(async (ctx, _args, command) => {
      const options = command.opts<{ folder: string; file?: string }>();
      const definition = options.file
        ? jsonObject(await readJson(options.file), "The request definition")
        : undefined;
      ctx.show(
        await ctx.api.request("POST", "/api/requests", {
          body: {
            workspaceId: await ctx.workspace(),
            folderId: options.folder,
            ...(definition ? { request: definition } : {}),
          },
        }),
      );
    }),
  );
  request
    .command("update <id>")
    .description("Change a request using a JSON patch")
    .requiredOption("-f, --file <path>", 'JSON fields to change, or "-" for standard input')
    .action(
      act(async (ctx, [requestId], command) => {
        const patch = jsonObject(await readJson(command.opts<{ file: string }>().file), "The patch");
        ctx.show(await ctx.api.request("PATCH", `/api/requests/${enc(requestId)}`, { body: patch }));
      }),
    );
  request
    .command("duplicate <id>")
    .description("Duplicate a request")
    .action(
      act(async (ctx, [requestId]) =>
        ctx.show(await ctx.api.request("POST", `/api/requests/${enc(requestId)}/duplicate`)),
      ),
    );
  request
    .command("delete <id>")
    .description("Delete a request")
    .action(
      act(async (ctx, [requestId]) => {
        await ctx.confirm(`Delete request ${requestId}?`);
        await ctx.api.request("DELETE", `/api/requests/${enc(requestId)}`);
        out(`Deleted request ${requestId}`);
      }),
    );

  const example = group(program, "example", "Manage saved response examples of a request");
  withList(example.command("list <requestId>").description("List a request's examples")).action(
    act(async (ctx, [requestId]) => {
      const found = await ctx.api.request<{ examples?: Row[] } | Row[]>(
        "GET",
        `/api/requests/${enc(requestId)}/examples`,
      );
      const rows = Array.isArray(found) ? found : (found.examples ?? []);
      ctx.list(rows, [id, name, column("STATUS", "status")]);
    }),
  );
  example
    .command("apply <requestId>")
    .description("Apply an example mutation: create, update, duplicate, delete or reorder")
    .requiredOption(
      "-f, --file <path>",
      'JSON {"mutation": {...}, "expectedVersion"?: "..."} or "-" for standard input',
    )
    .action(
      act(async (ctx, [requestId], command) => {
        const body = jsonObject(await readJson(command.opts<{ file: string }>().file), "The example command");
        ctx.show(await ctx.api.request("POST", `/api/requests/${enc(requestId)}/examples`, { body }));
      }),
    );

  // ------------------------------------------------------------ mock servers
  const mock = group(program, "mock", "Inspect and manage a server's mock servers");
  withWorkspace(withList(mock.command("list").description("List mock servers"))).action(
    act(async (ctx) =>
      ctx.list(
        await ctx.api.request<Row[]>("GET", "/api/mocks", { query: { workspaceId: await ctx.workspace() } }),
        [id, name],
      ),
    ),
  );
  mock
    .command("get <id>")
    .description("Show a mock server")
    .action(
      act(async (ctx, [mockId]) => ctx.show(await ctx.api.request("GET", `/api/mocks/${enc(mockId)}`))),
    );
  withList(mock.command("logs <id>").description("List a mock server's recent request log")).action(
    act(async (ctx, [mockId]) => {
      const logs = await ctx.api.request<Row[] | { logs?: Row[] }>("GET", `/api/mocks/${enc(mockId)}/logs`);
      ctx.list(Array.isArray(logs) ? logs : (logs.logs ?? []), [
        id,
        column("METHOD", "method"),
        column("PATH", "path"),
        column("STATUS", "status"),
      ]);
    }),
  );
  mock
    .command("reset <id>")
    .description("Restart failure-simulation counters and handler state for one session or all sessions")
    .option("--session <name>", "Only this x-mock-session (default: all sessions)")
    .action(
      act(async (ctx, [mockId], command) => {
        const { session } = command.opts<{ session?: string }>();
        const result = await ctx.api.request<{ cleared?: number }>(
          "POST",
          `/api/mocks/${enc(mockId)}/reset`,
          {
            body: session ? { session } : {},
          },
        );
        out(`Reset mock ${mockId}${session ? ` session ${session}` : ""} (${result.cleared ?? 0} cleared)`);
      }),
    );
  mock
    .command("delete <id>")
    .description("Delete a mock server")
    .action(
      act(async (ctx, [mockId]) => {
        await ctx.confirm(`Delete mock ${mockId}?`);
        await ctx.api.request("DELETE", `/api/mocks/${enc(mockId)}`);
        out(`Deleted mock ${mockId}`);
      }),
    );

  withWorkspace(
    mock
      .command("launch <collectionId>")
      .description(
        "Serve a collection's saved examples as a mock; prints its URL and one-time key (use `postbox mock reset` between test runs)",
      )
      .option("--name <name>", "Mock name (default: Mock of <collection id>)")
      .option("--public", "Allow calls without the mock key")
      .option("--handlers <file>", "JSON array of handlers {id,name,match?,code}")
      .option("--scenarios <file>", "JSON array of failure simulations"),
  ).action(
    act(async (ctx, [collectionId], command) => {
      const options = command.opts<{
        name?: string;
        public?: boolean;
        handlers?: string;
        scenarios?: string;
      }>();
      const created = await ctx.api.request<Row>("POST", "/api/mocks", {
        body: {
          workspaceId: await ctx.workspace(),
          folderId: collectionId,
          name: options.name ?? `Mock of ${collectionId}`,
          ...(options.public ? { public: true } : {}),
          ...(options.handlers ? { handlers: jsonArray(await readJson(options.handlers), "Handlers") } : {}),
          ...(options.scenarios
            ? { scenarios: jsonArray(await readJson(options.scenarios), "Scenarios") }
            : {}),
        },
      });
      const base = `${ctx.api.base}/mock/${String(created.id)}`;
      ctx.show({ id: created.id, name: created.name, url: base, key: created.key });
      if (!options.public)
        console.error("Send the key in the x-postbox-mock-key header. It is shown only once.");
    }),
  );
  mock
    .command("state <id>")
    .description("Show per-session handler state and call counts")
    .action(
      act(async (ctx, [mockId]) => ctx.show(await ctx.api.request("GET", `/api/mocks/${enc(mockId)}/state`))),
    );
  mock
    .command("refresh <id>")
    .description("Capture the collection's latest saved examples")
    .action(
      act(async (ctx, [mockId]) =>
        ctx.show(await ctx.api.request("POST", `/api/mocks/${enc(mockId)}/refresh`)),
      ),
    );
  const handler = group(mock, "handler", "Sandboxed JavaScript handlers of a mock server");
  handler
    .command("set <mockId> <file>")
    .description(
      "Add or replace a handler from a JavaScript file (the body of function (req, state, example, ctx))",
    )
    .option("--id <id>", "Handler id (default: derived from the file name); an existing id is replaced")
    .option("--name <name>", "Display name (default: the id)")
    .option("--method <method>", "Only this HTTP method")
    .option("--path <path>", "Only this path, e.g. /users/:id")
    .option("--disabled", "Save it switched off")
    .action(
      act(async (ctx, [mockId, file], command) => {
        const options = command.opts<{
          id?: string;
          name?: string;
          method?: string;
          path?: string;
          disabled?: boolean;
        }>();
        let code: string;
        try {
          code = await readFile(file, "utf8");
        } catch (error) {
          throw new CliError(`Cannot read ${file}: ${(error as Error).message}`, EXIT.usage);
        }
        const handlerId =
          options.id ?? (file.split(/[\\/]/).pop() ?? "handler").replace(/\.[^.]*$/, "").slice(0, 64);
        const current = await ctx.api.request<{ handlers?: Row[] }>("GET", `/api/mocks/${enc(mockId)}`);
        const next = {
          id: handlerId,
          name: options.name ?? handlerId,
          enabled: !options.disabled,
          match: {
            ...(options.method ? { method: options.method.toUpperCase() } : {}),
            ...(options.path ? { path: options.path } : {}),
          },
          code,
        };
        const others = (current.handlers ?? []).filter((h) => h.id !== handlerId);
        ctx.show(
          await ctx.api.request("PATCH", `/api/mocks/${enc(mockId)}`, {
            body: { handlers: [...others, next] },
          }),
        );
      }),
    );
  handler
    .command("test <mockId> <file>")
    .description("Run a handler file in the sandbox against a made-up request; nothing is saved")
    .option("--method <method>", "Request method", "GET")
    .option("--path <path>", "Request path", "/")
    .option("--body <text>", "Request body")
    .option("--state <json>", "Starting session state as JSON", "{}")
    .option("--count <n>", "Call number to rehearse", count(1))
    .action(
      act(async (ctx, [mockId, file], command) => {
        const options = command.opts<{
          method: string;
          path: string;
          body?: string;
          state: string;
          count?: number;
        }>();
        let code: string;
        let state: unknown;
        try {
          code = await readFile(file, "utf8");
          state = JSON.parse(options.state);
        } catch (error) {
          throw new CliError(`Cannot read the handler or state: ${(error as Error).message}`, EXIT.usage);
        }
        const result = await ctx.api.request<{ ok: boolean; error?: string; logs: string[] }>(
          "POST",
          `/api/mocks/${enc(mockId)}/handlers/test`,
          {
            body: {
              code,
              request: {
                method: options.method,
                path: options.path,
                ...(options.body ? { body: options.body } : {}),
              },
              state,
              ...(options.count ? { count: options.count } : {}),
            },
          },
        );
        for (const line of result.logs ?? []) console.error(`log: ${line}`);
        ctx.show(result);
        if (!result.ok) throw new CliError(`Handler failed: ${result.error}`, EXIT.failure);
      }),
    );
  handler
    .command("delete <mockId> <handlerId>")
    .description("Remove a handler")
    .action(
      act(async (ctx, [mockId, handlerId]) => {
        const current = await ctx.api.request<{ handlers?: Row[] }>("GET", `/api/mocks/${enc(mockId)}`);
        const rest = (current.handlers ?? []).filter((h) => h.id !== handlerId);
        if (rest.length === (current.handlers ?? []).length)
          throw new CliError(`No handler "${handlerId}" on this mock.`, EXIT.notFound);
        await ctx.api.request("PATCH", `/api/mocks/${enc(mockId)}`, { body: { handlers: rest } });
        out(`Removed handler ${handlerId}`);
      }),
    );

  // ------------------------------------------------------------ secrets vault
  const vaultCmd = group(program, "vault", "Manage the workspace secrets vault (values are write-only)");
  const secretByName = async (ctx: Ctx, nameOrId: string) => {
    const list = await ctx.api.request<Row[]>("GET", "/api/vault", {
      query: { workspaceId: await ctx.workspace() },
    });
    return list.find((item) => item.name === nameOrId || item.id === nameOrId);
  };
  withWorkspace(
    withList(vaultCmd.command("list").description("List secrets (names and settings, never values)")),
  ).action(
    act(async (ctx) =>
      ctx.list(
        await ctx.api.request<Row[]>("GET", "/api/vault", { query: { workspaceId: await ctx.workspace() } }),
        [name, column("STATE", "state"), column("SCRIPTS", "scriptAccess"), column("REFERENCE", "reference")],
      ),
    ),
  );
  withWorkspace(
    vaultCmd
      .command("set <name>")
      .description(
        "Store or replace a secret. The value is read from a file or standard input, never from arguments.",
      )
      .option(
        "--value-file <path>",
        'File holding the value, or "-" for standard input (default when input is piped)',
      )
      .option("--description <text>", "What the secret is for")
      .option("--script-access", "Let scripts read it with pm.vault.get")
      .option("--no-script-access", "Do not let scripts read it")
      .option(
        "--domains <list>",
        "Only send it to these hosts, comma separated (api.example.com, *.example.org)",
      )
      .option("--personal", "Only you can use it (new secrets only)")
      .option("--disable", "Switch it off without deleting it")
      .option("--enable", "Switch it back on")
      .option(
        "--collection <id>",
        "Only available in this collection (repeatable)",
        (v: string, p: string[]) => [...p, v],
        [],
      ),
  ).action(
    act(async (ctx, [secretName], command) => {
      const o = command.opts<{
        valueFile?: string;
        description?: string;
        scriptAccess?: boolean;
        collection: string[];
        domains?: string;
        personal?: boolean;
        disable?: boolean;
        enable?: boolean;
      }>();
      const source = o.valueFile ?? (process.stdin.isTTY ? undefined : "-");
      if (!source)
        throw new CliError("Provide the value with --value-file <path> or pipe it in.", EXIT.usage);
      let value: string;
      try {
        value = source === "-" ? await readStdin() : await readFile(source, "utf8");
      } catch (error) {
        throw new CliError(`Cannot read ${source}: ${(error as Error).message}`, EXIT.usage);
      }
      value = value.replace(/\r?\n$/, "");
      const existing = await secretByName(ctx, secretName);
      const settings = {
        ...(o.description !== undefined ? { description: o.description } : {}),
        ...(o.scriptAccess !== undefined ? { scriptAccess: o.scriptAccess } : {}),
        ...(o.collection.length ? { collectionIds: o.collection } : {}),
        ...(o.domains !== undefined
          ? {
              domains: o.domains
                .split(",")
                .map((d) => d.trim())
                .filter(Boolean),
            }
          : {}),
        ...(o.disable ? { enabled: false } : o.enable ? { enabled: true } : {}),
      };
      ctx.show(
        existing
          ? await ctx.api.request("PATCH", `/api/vault/${enc(String(existing.id))}`, {
              body: { value, ...settings },
            })
          : await ctx.api.request("POST", "/api/vault", {
              body: { workspaceId: await ctx.workspace(), name: secretName, value, ...settings },
            }),
      );
    }),
  );
  withWorkspace(vaultCmd.command("delete <name>").description("Delete a secret")).action(
    act(async (ctx, [secretName]) => {
      const existing = await secretByName(ctx, secretName);
      if (!existing) throw new CliError(`No secret "${secretName}" in this workspace.`, EXIT.notFound);
      await ctx.confirm(`Delete secret ${secretName}?`);
      await ctx.api.request("DELETE", `/api/vault/${enc(String(existing.id))}`);
      out(`Deleted secret ${secretName}`);
    }),
  );
  withWorkspace(
    vaultCmd
      .command("migrate")
      .description("Move secret variables into the vault, leaving {{vault:name}} references")
      .option("--script-access", "Let scripts read the moved values with pm.vault.get"),
  ).action(
    act(async (ctx, _args, command) =>
      ctx.show(
        await ctx.api.request("POST", "/api/vault/migrate", {
          body: {
            workspaceId: await ctx.workspace(),
            ...(command.opts<{ scriptAccess?: boolean }>().scriptAccess ? { scriptAccess: true } : {}),
          },
        }),
      ),
    ),
  );
  withWorkspace(
    vaultCmd
      .command("reveal <name>")
      .description("Print a secret's value (its creator or a workspace owner; audited)"),
  ).action(
    act(async (ctx, [secretName]) => {
      const existing = await secretByName(ctx, secretName);
      if (!existing) throw new CliError(`No secret "${secretName}" in this workspace.`, EXIT.notFound);
      const { value } = await ctx.api.request<{ value: string }>(
        "POST",
        `/api/vault/${enc(String(existing.id))}/reveal`,
      );
      process.stdout.write(value + (process.stdout.isTTY ? "\n" : ""));
    }),
  );
  withWorkspace(
    vaultCmd
      .command("export")
      .description("Write the workspace's secrets to a passphrase-protected file (workspace owners)")
      .requiredOption("--out <file>", "File to write")
      .option("--passphrase-file <path>", 'File holding the passphrase, or "-" for standard input')
      .option("--include-personal", "Include your personal secrets"),
  ).action(
    act(async (ctx, _args, command) => {
      const o = command.opts<{ out: string; passphraseFile?: string; includePersonal?: boolean }>();
      if (!o.passphraseFile)
        throw new CliError(
          "Provide the passphrase with --passphrase-file <path> (or - for standard input).",
          EXIT.usage,
        );
      let passphrase: string;
      try {
        passphrase = (
          o.passphraseFile === "-" ? await readStdin() : await readFile(o.passphraseFile, "utf8")
        ).replace(/\r?\n$/, "");
      } catch (error) {
        throw new CliError(`Cannot read ${o.passphraseFile}: ${(error as Error).message}`, EXIT.usage);
      }
      const text = await ctx.api.request<string>("POST", "/api/vault/export", {
        raw: true,
        body: {
          workspaceId: await ctx.workspace(),
          passphrase,
          ...(o.includePersonal ? { includePersonal: true } : {}),
        },
      });
      await writeFile(o.out, text, { mode: 0o600 });
      out(`Wrote ${o.out}`);
    }),
  );
  withWorkspace(
    vaultCmd
      .command("import <file>")
      .description("Add the secrets from an export file")
      .option("--passphrase-file <path>", 'File holding the passphrase, or "-" for standard input')
      .option("--on-conflict <mode>", "skip, replace or rename when a name exists", "skip"),
  ).action(
    act(async (ctx, [file], command) => {
      const o = command.opts<{ passphraseFile?: string; onConflict: string }>();
      if (!["skip", "replace", "rename"].includes(o.onConflict))
        throw new CliError("Use skip, replace or rename.", EXIT.usage);
      let passphrase: string | undefined;
      if (o.passphraseFile) {
        try {
          passphrase = (
            o.passphraseFile === "-" ? await readStdin() : await readFile(o.passphraseFile, "utf8")
          ).replace(/\r?\n$/, "");
        } catch (error) {
          throw new CliError(`Cannot read ${o.passphraseFile}: ${(error as Error).message}`, EXIT.usage);
        }
      }
      ctx.show(
        await ctx.api.request("POST", "/api/vault/import", {
          body: {
            workspaceId: await ctx.workspace(),
            file: await readJson(file),
            ...(passphrase ? { passphrase } : {}),
            onConflict: o.onConflict,
          },
        }),
      );
    }),
  );
  vaultCmd
    .command("status")
    .description("Show where the vault key comes from and how many secrets use each key (administrators)")
    .action(act(async (ctx) => ctx.show(await ctx.api.request("GET", "/api/admin/vault"))));
  vaultCmd
    .command("rotate")
    .description("Re-encrypt every secret under the current key (administrators)")
    .option("--new-key", "Generate a new key first (key-file setups)")
    .option("--prune", "Remove keys no secret uses any more from the key file")
    .action(
      act(async (ctx, _args, command) => {
        const o = command.opts<{ newKey?: boolean; prune?: boolean }>();
        ctx.show(
          await ctx.api.request("POST", "/api/admin/vault/rotate", {
            body: { ...(o.newKey ? { newKey: true } : {}), ...(o.prune ? { prune: true } : {}) },
          }),
        );
      }),
    );

  // ------------------------------------------------------------ environments and globals
  const env = group(program, "env", "Manage environments");
  withWorkspace(withList(env.command("list").description("List environments"))).action(
    act(async (ctx) =>
      ctx.list(
        await ctx.api.request<Row[]>("GET", "/api/environments", {
          query: { workspaceId: await ctx.workspace() },
        }),
        [id, name],
      ),
    ),
  );
  env
    .command("get <id>")
    .description("Show an environment")
    .action(
      act(async (ctx, [envId]) => ctx.show(await ctx.api.request("GET", `/api/environments/${enc(envId)}`))),
    );
  withWorkspace(
    env
      .command("create <name>")
      .description("Create an environment")
      .option("-f, --file <path>", 'JSON array of variables {key,value,type?,enabled?}, or "-"'),
  ).action(
    act(async (ctx, [envName], command) => {
      const file = command.opts<{ file?: string }>().file;
      const variables = file ? jsonArray(await readJson(file), "Variables") : undefined;
      ctx.show(
        await ctx.api.request("POST", "/api/environments", {
          body: { workspaceId: await ctx.workspace(), name: envName, ...(variables ? { variables } : {}) },
        }),
      );
    }),
  );
  env
    .command("update <id>")
    .description("Rename an environment and/or replace its variables")
    .option("--name <name>", "New name")
    .option("-f, --file <path>", 'JSON array of variables that replaces the current list, or "-"')
    .action(
      act(async (ctx, [envId], command) => {
        const options = command.opts<{ name?: string; file?: string }>();
        if (!options.name && !options.file) throw new CliError("Give --name and/or --file.", EXIT.usage);
        const variables = options.file ? jsonArray(await readJson(options.file), "Variables") : undefined;
        ctx.show(
          await ctx.api.request("PATCH", `/api/environments/${enc(envId)}`, {
            body: { ...(options.name ? { name: options.name } : {}), ...(variables ? { variables } : {}) },
          }),
        );
      }),
    );
  env
    .command("duplicate <id>")
    .description("Duplicate an environment")
    .action(
      act(async (ctx, [envId]) =>
        ctx.show(await ctx.api.request("POST", `/api/environments/${enc(envId)}/duplicate`)),
      ),
    );
  env
    .command("delete <id>")
    .description("Delete an environment")
    .action(
      act(async (ctx, [envId]) => {
        await ctx.confirm(`Delete environment ${envId}?`);
        await ctx.api.request("DELETE", `/api/environments/${enc(envId)}`);
        out(`Deleted environment ${envId}`);
      }),
    );
  env
    .command("export <id>")
    .description("Export an environment as Postman JSON")
    .option("--out <file>", "Write to a file instead of standard output")
    .option("--include-secrets", "Include secret variable values")
    .action(
      act(async (ctx, [envId], command) => {
        const options = command.opts<{ out?: string; includeSecrets?: boolean }>();
        await writeOutput(
          await ctx.api.request<string>("GET", `/api/export/environment/${enc(envId)}`, {
            raw: true,
            query: { includeSecrets: options.includeSecrets ? "1" : undefined },
          }),
          options.out,
        );
      }),
    );

  const globals = group(program, "globals", "Manage workspace global variables");
  withWorkspace(globals.command("get").description("Show global variables")).action(
    act(async (ctx) =>
      ctx.show(
        await ctx.api.request("GET", "/api/variables", {
          query: { workspaceId: await ctx.workspace(), scope: "global" },
        }),
      ),
    ),
  );
  withWorkspace(
    globals
      .command("set")
      .description("Replace all global variables")
      .requiredOption("-f, --file <path>", 'JSON array of variables {key,value,type?,enabled?}, or "-"'),
  ).action(
    act(async (ctx, _args, command) => {
      const variables = jsonArray(await readJson(command.opts<{ file: string }>().file), "Variables");
      ctx.show(
        await ctx.api.request("PUT", "/api/variables", {
          body: { workspaceId: await ctx.workspace(), scope: "global", variables },
        }),
      );
    }),
  );
  withWorkspace(
    globals
      .command("export")
      .description("Export global variables as Postman JSON")
      .option("--out <file>", "Write to a file instead of standard output")
      .option("--include-secrets", "Include secret variable values"),
  ).action(
    act(async (ctx, _args, command) => {
      const options = command.opts<{ out?: string; includeSecrets?: boolean }>();
      await writeOutput(
        await ctx.api.request<string>("GET", "/api/export/environment/globals", {
          raw: true,
          query: {
            workspaceId: await ctx.workspace(),
            includeSecrets: options.includeSecrets ? "1" : undefined,
          },
        }),
        options.out,
      );
    }),
  );
}

const enc = encodeURIComponent;
