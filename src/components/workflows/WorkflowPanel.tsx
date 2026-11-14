"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, GitBranch, Play, Plus, Save, Trash2 } from "lucide-react";
import {
  parseGraph,
  validateGraph,
  pathExpression,
  expressionSchema,
  type Expression,
  type FlowGraph,
  type FlowNode,
} from "@/core/workflows/model";
import type { FlowTrace } from "@/core/workflows/engine";
import styles from "./workflows.module.css";

type Summary = { id: string; name: string; revision: number; latestVersion: number };
type Version = { version: number; contentHash: string; readable: boolean };
type Workflow = Summary & { description: string; graph: FlowGraph; versions: Version[] };
type Catalog = {
  workflows: Summary[];
  permissions: { read: boolean; write: boolean; run: boolean; manage: boolean };
  requests: { id: string; name: string; method: string; url: string }[];
  environments: { id: string; name: string }[];
};
type Run = {
  id: string;
  status: string;
  source: string;
  steps: number;
  output: unknown;
  error: string | null;
  trace: FlowTrace[];
  traceOmitted: number;
  durationMs: number;
  contentHash: string;
  version: number | null;
  sourceRevision: number | null;
};
type Deployment = {
  id: string;
  name: string;
  version: number;
  revision: number;
  enabled: boolean;
  environmentId: string | null;
  cron: string | null;
  webhookEnabled: boolean;
  webhookConfigured: boolean;
  endpoint: string;
  input: unknown;
  nextRun: string | null;
  lastError: string | null;
  actor: { kind: string; userId?: string; tokenId?: string | null };
};
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error === "Invalid input" && result.issues
        ? result.issues.map((i: { message: string }) => i.message).join("; ")
        : (result.error ?? "Workflow operation failed"),
    );
  return result;
}
const types: FlowNode["type"][] = ["request", "condition", "loop", "transform", "subflow", "output"];
function edges(node: FlowNode): [string, string][] {
  if (node.type === "condition")
    return [
      ["whenTrue", node.whenTrue],
      ["whenFalse", node.whenFalse],
    ];
  if (node.type === "output") return [];
  return [
    "next" in node ? ["next", node.next ?? ""] : ["next", ""],
    ...(node.type === "request" ? [["onError", node.onError ?? ""]] : []),
    ...(node.type === "loop" ? [["body", node.body]] : []),
  ] as [string, string][];
}
function ExpressionEditor({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: Expression;
  onChange: (value: Expression) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(pretty(value)),
    [error, setError] = useState("");
  const commit = () => {
    try {
      const parsed = expressionSchema.parse(JSON.parse(text));
      onChange(parsed);
      setError("");
    } catch {
      setError("Enter a valid JSON expression");
    }
  };
  return (
    <fieldset disabled={disabled}>
      <legend>{label}</legend>
      <label>
        Expression type
        <select
          aria-label={`${label} type`}
          value={value.kind}
          onChange={(e) => {
            const kind = e.target.value;
            const next: Expression =
              kind === "path"
                ? pathExpression("value")
                : kind === "literal"
                  ? { kind: "literal", value: null }
                  : kind === "op"
                    ? {
                        kind: "op",
                        op: "eq",
                        args: [pathExpression("value.status"), { kind: "literal", value: 200 }],
                      }
                    : kind === "array"
                      ? { kind: "array", items: [] }
                      : { kind: "object", fields: {} };
            setText(pretty(next));
            onChange(next);
          }}
        >
          <option>path</option>
          <option>literal</option>
          <option>op</option>
          <option>array</option>
          <option>object</option>
        </select>
      </label>
      {value.kind === "path" && (
        <label>
          Data path
          <input
            aria-label={`${label} path`}
            value={value.path}
            onChange={(e) => {
              const next = pathExpression(e.target.value);
              setText(pretty(next));
              onChange(next);
            }}
          />
        </label>
      )}
      <label>
        Expression JSON
        <textarea
          aria-label={`${label} JSON`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
        />
      </label>
      <button type="button" onClick={commit}>
        Apply expression
      </button>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
export function WorkflowPanel() {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]),
    [workspaceId, setWorkspaceId] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [workflow, setWorkflow] = useState<Workflow | null>(null),
    [graph, setGraph] = useState<FlowGraph | null>(null);
  const [selectedId, setSelectedId] = useState(""),
    [dirty, setDirty] = useState(false),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<{ nodeId: string; port: string } | null>(null);
  const [input, setInput] = useState("{}"),
    [fixtures, setFixtures] = useState("{}"),
    [environmentId, setEnvironmentId] = useState("");
  const [run, setRun] = useState<Run | null>(null),
    [history, setHistory] = useState<Run[]>([]),
    [traceIndex, setTraceIndex] = useState<number | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]),
    [deployment, setDeployment] = useState<Deployment | null>(null);
  const [deploymentName, setDeploymentName] = useState("Deployment"),
    [version, setVersion] = useState(1),
    [cron, setCron] = useState(""),
    [deployInput, setDeployInput] = useState("{}"),
    [enabled, setEnabled] = useState(false),
    [webhookEnabled, setWebhookEnabled] = useState(false),
    [deploymentEnvironment, setDeploymentEnvironment] = useState("");
  const [token, setToken] = useState<{ id: string; endpoint: string; token: string } | null>(null),
    [graphText, setGraphText] = useState("");
  const canvas = useRef<HTMLDivElement>(null),
    drag = useRef<{ id: string; x: number; y: number; origin: { x: number; y: number } } | null>(null);
  const allow = catalog?.permissions,
    selected = graph?.nodes.find((node) => node.id === selectedId);
  const task = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Workflow operation failed");
    } finally {
      setBusy(false);
    }
  };
  const refresh = useCallback(
    async (id: string) => {
      const [nextCatalog, nextDeployments, nextHistory] = await Promise.all([
        call<Catalog>(`/api/workflows?workspaceId=${encodeURIComponent(workspaceId)}`),
        call<Deployment[]>(`/api/workflows/${id}/deployments`),
        call<Run[]>(`/api/workflows/${id}/runs`),
      ]);
      setCatalog(nextCatalog);
      setDeployments(nextDeployments);
      setHistory(nextHistory);
    },
    [workspaceId],
  );
  useEffect(() => {
    let active = true;
    call<{ id: string; name: string }[]>("/api/workspaces")
      .then((rows) => {
        if (active) {
          setWorkspaces(rows);
          setWorkspaceId(rows[0]?.id ?? "");
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (workspaceId)
      call<Catalog>(`/api/workflows?workspaceId=${encodeURIComponent(workspaceId)}`)
        .then((value) => {
          if (active) setCatalog(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [workspaceId]);
  const running = run && ["queued", "running"].includes(run.status);
  useEffect(() => {
    if (!running || !run) return;
    let active = true;
    const timer = setInterval(() => {
      call<Run>(`/api/workflow-runs/${run.id}`)
        .then((next) => {
          if (active) {
            setRun(next);
            if (!["queued", "running"].includes(next.status) && workflow)
              void refresh(workflow.id).catch((e) => setError(e.message));
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [running, run, workflow, refresh]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const abandon = () => !dirty || window.confirm("Discard unsaved workflow changes?");
  const open = async (id: string) => {
    const value = await call<Workflow>(`/api/workflows/${id}`);
    setWorkflow(value);
    setName(value.name);
    setGraph(value.graph);
    setGraphText(pretty(value.graph));
    setSelectedId(value.graph.entry);
    setDirty(false);
    setConnection(null);
    setRun(null);
    setDeployment(null);
    setToken(null);
    await refresh(id);
  };
  const change = (next: FlowGraph) => {
    setGraph(next);
    setGraphText(pretty(next));
    setDirty(true);
  };
  const updateNode = (patch: Partial<FlowNode>) => {
    if (graph && selected) {
      try {
        change(
          parseGraph({
            ...graph,
            nodes: graph.nodes.map((node) =>
              node.id === selected.id ? ({ ...node, ...patch } as FlowNode) : node,
            ),
          }),
        );
        setError("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Invalid block settings");
      }
    }
  };
  const add = (type: FlowNode["type"], position?: { x: number; y: number }) => {
    if (!graph || !allow?.write) return;
    const id = `${type}_${crypto.randomUUID().slice(0, 8)}`,
      base = {
        id,
        label: type[0].toUpperCase() + type.slice(1),
        position: position ?? {
          x: 80 + (graph.nodes.length % 3) * 270,
          y: 260 + Math.floor(graph.nodes.length / 3) * 160,
        },
      };
    const node: FlowNode =
      type === "request"
        ? {
            ...base,
            type,
            requestId: catalog?.requests[0]?.id ?? "",
            bindings: {},
            failOnHttpError: true,
            failOnTests: true,
          }
        : type === "condition"
          ? {
              ...base,
              type,
              expression: {
                kind: "op",
                op: "eq",
                args: [pathExpression("value.status"), { kind: "literal", value: 200 }],
              },
              whenTrue: "",
              whenFalse: "",
            }
          : type === "loop"
            ? { ...base, type, items: pathExpression("value"), body: "", concurrency: 1, maxIterations: 100 }
            : type === "subflow"
              ? { ...base, type, workflowId: "", version: 1, input: pathExpression("value") }
              : { ...base, type, expression: pathExpression("value") };
    change({ ...graph, nodes: [...graph.nodes, node] });
    setSelectedId(id);
  };
  const save = async () => {
    if (!workflow || !graph) return;
    const next = await call<Workflow>(`/api/workflows/${workflow.id}`, "PUT", {
      revision: workflow.revision,
      name,
      graph: parseGraph(graph),
    });
    setWorkflow(next);
    setDirty(false);
    await refresh(next.id);
    setNotice("Workflow saved");
  };
  const start = async (fixture: boolean) => {
    if (!workflow || !graph) return;
    const result = await call<{ runId: string }>(
      `/api/workflows/${workflow.id}/${fixture ? "preview" : "runs"}`,
      "POST",
      {
        graph: parseGraph(graph),
        input: JSON.parse(input),
        environmentId: environmentId || null,
        ...(fixture ? { fixtures: JSON.parse(fixtures) } : {}),
      },
    );
    setTraceIndex(null);
    setRun(await call<Run>(`/api/workflow-runs/${result.runId}`));
    await refresh(workflow.id);
  };
  const editDeployment = (value: Deployment | null) => {
    setDeployment(value);
    setDeploymentName(value?.name ?? "Deployment");
    setVersion(value?.version ?? workflow?.versions[0]?.version ?? 1);
    setCron(value?.cron ?? "");
    setDeployInput(pretty(value?.input ?? {}));
    setEnabled(value?.enabled ?? false);
    setWebhookEnabled(value?.webhookEnabled ?? false);
    setDeploymentEnvironment(value?.environmentId ?? "");
    setToken(null);
  };
  const captureToken = (value: Deployment & { token?: string }) => {
    if (value.token) setToken({ id: value.id, endpoint: value.endpoint, token: value.token });
  };
  const issues = graph ? validateGraph(graph) : [];
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" target="_blank" rel="noopener noreferrer">
          <ArrowLeft size={16} /> API client
        </Link>
        <h1>
          <GitBranch size={22} /> API workflows
        </h1>
        <label>
          Workspace
          <select
            aria-label="Workflow workspace"
            value={workspaceId}
            onChange={(e) => {
              if (abandon()) {
                setWorkspaceId(e.target.value);
                setCatalog(null);
                setWorkflow(null);
                setGraph(null);
                setRun(null);
                setDirty(false);
                setToken(null);
              }
            }}
          >
            {workspaces.map((w) => (
              <option value={w.id} key={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      <div className={styles.layout}>
        <aside className={styles.library}>
          <h2>Workflows</h2>
          <button
            disabled={busy || !allow?.write}
            onClick={() => {
              if (abandon())
                void task(async () => {
                  const value = await call<Workflow>("/api/workflows", "POST", {
                    workspaceId,
                    name: "New workflow",
                  });
                  await open(value.id);
                });
            }}
          >
            <Plus size={14} /> New workflow
          </button>
          {catalog?.workflows.map((item) => (
            <button
              aria-current={workflow?.id === item.id ? "true" : undefined}
              key={item.id}
              onClick={() => {
                if (abandon()) void task(() => open(item.id));
              }}
            >
              {item.name}
              <small>{item.latestVersion ? `v${item.latestVersion}` : "Draft"}</small>
            </button>
          ))}
          {workflow && (
            <>
              <h2>Blocks</h2>
              <p>Drag onto the canvas, or click to add. Connect an output port to a block’s input.</p>
              {types.map((type) => (
                <button
                  key={type}
                  draggable={allow?.write}
                  onDragStart={(e) => e.dataTransfer.setData("application/postbox-flow-block", type)}
                  disabled={!allow?.write}
                  onClick={() => add(type)}
                >
                  Add {type}
                </button>
              ))}
            </>
          )}
          <details>
            <summary>Data expressions</summary>
            <p>
              Paths: input, value, steps.blockId, item, index. Build JSON expressions with literal, path, op,
              array or object. Use the guide for operations and examples.
            </p>
            <p>
              Request bindings become literal <code>{"{{flow.name}}"}</code> values in saved requests.
            </p>
          </details>
        </aside>
        <section className={styles.workspace}>
          {!workflow || !graph ? (
            <div className={styles.empty}>
              <GitBranch size={40} />
              <h2>Connect requests into a workflow</h2>
              <p>
                Create a workflow, add blocks, and preview it with deterministic fixtures before sending real
                requests.
              </p>
            </div>
          ) : (
            <>
              <div className={styles.toolbar}>
                <input
                  aria-label="Workflow name"
                  value={name}
                  disabled={!allow?.write}
                  onChange={(e) => {
                    setName(e.target.value);
                    setDirty(true);
                  }}
                />
                <span>{dirty ? "Unsaved changes" : `Revision ${workflow.revision}`}</span>
                <button disabled={busy || !allow?.write} onClick={() => void task(save)}>
                  <Save size={14} /> Save
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void task(async () => {
                      const result = await call<{ valid: boolean; issues: { message: string }[] }>(
                        `/api/workflows/${workflow.id}/validate`,
                        "POST",
                        { graph },
                      );
                      setNotice(
                        result.valid ? "Workflow is valid" : result.issues.map((i) => i.message).join("; "),
                      );
                    })
                  }
                >
                  Validate
                </button>
                <button disabled={busy} onClick={() => void task(() => open(workflow.id))}>
                  Reload
                </button>
                <button
                  aria-label="Delete workflow"
                  disabled={busy || !allow?.manage}
                  onClick={() => {
                    if (window.confirm("Delete this workflow and its run history? Remove deployments first."))
                      void task(async () => {
                        await call(`/api/workflows/${workflow.id}`, "DELETE");
                        setWorkflow(null);
                        setGraph(null);
                        setDirty(false);
                        setCatalog(await call<Catalog>(`/api/workflows?workspaceId=${workspaceId}`));
                      });
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className={styles.editor}>
                <div className={styles.canvasScroll}>
                  <div
                    ref={canvas}
                    className={styles.canvas}
                    aria-label="Workflow canvas"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const type = e.dataTransfer.getData(
                        "application/postbox-flow-block",
                      ) as FlowNode["type"];
                      if (types.includes(type)) {
                        const rect = canvas.current!.getBoundingClientRect();
                        add(type, {
                          x: Math.max(0, e.clientX - rect.left),
                          y: Math.max(0, e.clientY - rect.top),
                        });
                      }
                    }}
                    onPointerMove={(e) => {
                      if (!drag.current) return;
                      const d = drag.current;
                      change({
                        ...graph,
                        nodes: graph.nodes.map((n) =>
                          n.id === d.id
                            ? {
                                ...n,
                                position: {
                                  x: Math.max(0, d.origin.x + e.clientX - d.x),
                                  y: Math.max(0, d.origin.y + e.clientY - d.y),
                                },
                              }
                            : n,
                        ),
                      });
                    }}
                    onPointerUp={() => {
                      drag.current = null;
                    }}
                    onPointerCancel={() => {
                      drag.current = null;
                    }}
                    style={{
                      width: Math.max(1200, ...graph.nodes.map((n) => n.position.x + 260)),
                      height: Math.max(620, ...graph.nodes.map((n) => n.position.y + 200)),
                    }}
                  >
                    <svg className={styles.wires} aria-hidden="true">
                      <defs>
                        <marker
                          id="flow-arrow"
                          markerWidth="10"
                          markerHeight="10"
                          refX="8"
                          refY="3"
                          orient="auto"
                        >
                          <path d="M0,0 L0,6 L9,3 z" fill="currentColor" />
                        </marker>
                      </defs>
                      {graph.nodes.flatMap((source) =>
                        edges(source).map(([port, targetId], index) => {
                          const target = graph.nodes.find((n) => n.id === targetId);
                          if (!target) return null;
                          const x = source.position.x + 220,
                            y = source.position.y + 76 + index * 25,
                            tx = target.position.x,
                            ty = target.position.y + 42;
                          return (
                            <path
                              key={`${source.id}-${port}`}
                              d={`M ${x} ${y} C ${x + 60} ${y}, ${tx - 60} ${ty}, ${tx} ${ty}`}
                              markerEnd="url(#flow-arrow)"
                              className={
                                port === "onError" || port === "whenFalse" ? styles.errorWire : undefined
                              }
                            />
                          );
                        }),
                      )}
                    </svg>
                    {graph.nodes.map((node) => (
                      <article
                        key={node.id}
                        data-testid={`flow-node-${node.id}`}
                        className={`${styles.node} ${selectedId === node.id ? styles.selected : ""}`}
                        style={{ left: node.position.x, top: node.position.y }}
                      >
                        <div
                          className={styles.nodeTitle}
                          onPointerDown={(e) => {
                            setSelectedId(node.id);
                            if (allow?.write && e.button === 0) {
                              e.currentTarget.setPointerCapture(e.pointerId);
                              drag.current = {
                                id: node.id,
                                x: e.clientX,
                                y: e.clientY,
                                origin: node.position,
                              };
                            }
                          }}
                        >
                          <strong>{node.label}</strong>
                          <small>
                            {node.type}
                            {graph.entry === node.id ? " · Entry" : ""}
                          </small>
                        </div>
                        <button
                          className={styles.inputPort}
                          aria-label={`Connect to ${node.label}`}
                          disabled={!allow?.write || !connection}
                          onClick={() => {
                            if (connection) {
                              change({
                                ...graph,
                                nodes: graph.nodes.map((n) =>
                                  n.id === connection.nodeId
                                    ? ({ ...n, [connection.port]: node.id } as FlowNode)
                                    : n,
                                ),
                              });
                              setConnection(null);
                            }
                          }}
                        >
                          ●
                        </button>
                        {edges(node).map(([port, targetId]) => (
                          <button
                            key={port}
                            className={styles.port}
                            aria-pressed={connection?.nodeId === node.id && connection.port === port}
                            disabled={!allow?.write}
                            onClick={() => {
                              setConnection({ nodeId: node.id, port });
                              setSelectedId(node.id);
                            }}
                          >
                            {port === "whenTrue"
                              ? "True"
                              : port === "whenFalse"
                                ? "False"
                                : port === "onError"
                                  ? "On error"
                                  : port === "body"
                                    ? "Loop body"
                                    : "Next"}
                            <span>
                              {targetId
                                ? (graph.nodes.find((n) => n.id === targetId)?.label ?? "Missing")
                                : "End"}{" "}
                              ○
                            </span>
                          </button>
                        ))}
                      </article>
                    ))}
                  </div>
                </div>
                <aside className={styles.inspector}>
                  {connection && (
                    <p role="status">
                      Connecting {connection.port}. Choose a block’s input.{" "}
                      <button onClick={() => setConnection(null)}>Cancel connection</button>
                    </p>
                  )}
                  {selected && (
                    <>
                      <h2>Block settings</h2>
                      <label>
                        Block label
                        <input
                          aria-label="Block label"
                          value={selected.label}
                          disabled={!allow?.write}
                          onChange={(e) => updateNode({ label: e.target.value })}
                        />
                      </label>
                      <code>{selected.id}</code>
                      <button
                        disabled={!allow?.write}
                        onClick={() => change({ ...graph, entry: selected.id })}
                      >
                        Use as entry
                      </button>
                      {selected.type === "request" && (
                        <>
                          <label>
                            Saved request
                            <select
                              aria-label="Saved request"
                              disabled={!allow?.write}
                              value={selected.requestId}
                              onChange={(e) => updateNode({ requestId: e.target.value })}
                            >
                              <option value="">Choose request</option>
                              {catalog?.requests.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.method} {r.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <JsonEditor
                            key={`${selected.id}-bindings`}
                            label="Request bindings"
                            value={selected.bindings}
                            disabled={!allow?.write}
                            onChange={(value) =>
                              updateNode({ bindings: value as Record<string, Expression> })
                            }
                          />
                          <label>
                            <input
                              type="checkbox"
                              checked={selected.failOnHttpError}
                              disabled={!allow?.write}
                              onChange={(e) => updateNode({ failOnHttpError: e.target.checked })}
                            />{" "}
                            Fail on HTTP errors
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={selected.failOnTests}
                              disabled={!allow?.write}
                              onChange={(e) => updateNode({ failOnTests: e.target.checked })}
                            />{" "}
                            Fail on failed tests
                          </label>
                        </>
                      )}
                      {(selected.type === "transform" ||
                        selected.type === "condition" ||
                        selected.type === "output") && (
                        <ExpressionEditor
                          key={selected.id}
                          label={selected.type === "condition" ? "Condition" : "Value"}
                          value={selected.expression}
                          disabled={!allow?.write}
                          onChange={(expression) => updateNode({ expression })}
                        />
                      )}
                      {selected.type === "loop" && (
                        <>
                          <ExpressionEditor
                            key={selected.id}
                            label="Items"
                            value={selected.items}
                            disabled={!allow?.write}
                            onChange={(items) => updateNode({ items })}
                          />
                          <label>
                            Maximum iterations
                            <input
                              type="number"
                              min={1}
                              max={1000}
                              value={selected.maxIterations}
                              disabled={!allow?.write}
                              onChange={(e) => updateNode({ maxIterations: Number(e.target.value) })}
                            />
                          </label>
                          <label>
                            Parallel iterations
                            <input
                              type="number"
                              min={1}
                              max={4}
                              value={selected.concurrency}
                              disabled={!allow?.write}
                              onChange={(e) => updateNode({ concurrency: Number(e.target.value) })}
                            />
                          </label>
                        </>
                      )}
                      {selected.type === "subflow" && (
                        <>
                          <label>
                            Reusable workflow
                            <select
                              disabled={!allow?.write}
                              value={selected.workflowId}
                              onChange={(e) =>
                                updateNode({
                                  workflowId: e.target.value,
                                  version:
                                    catalog?.workflows.find((w) => w.id === e.target.value)?.latestVersion ||
                                    1,
                                })
                              }
                            >
                              <option value="">Choose published workflow</option>
                              {catalog?.workflows
                                .filter((w) => w.latestVersion && w.id !== workflow.id)
                                .map((w) => (
                                  <option key={w.id} value={w.id}>
                                    {w.name} · latest v{w.latestVersion}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <label>
                            Pinned version
                            <input
                              type="number"
                              min={1}
                              value={selected.version}
                              disabled={!allow?.write}
                              onChange={(e) => updateNode({ version: Number(e.target.value) })}
                            />
                          </label>
                          <ExpressionEditor
                            key={selected.id}
                            label="Subflow input"
                            value={selected.input}
                            disabled={!allow?.write}
                            onChange={(value) => updateNode({ input: value })}
                          />
                        </>
                      )}
                      {edges(selected).map(([port, value]) => (
                        <label key={port}>
                          {port}
                          <select
                            aria-label={`Edge ${port}`}
                            disabled={!allow?.write}
                            value={value}
                            onChange={(e) => updateNode({ [port]: e.target.value })}
                          >
                            <option value="">End / unconnected</option>
                            {graph.nodes.map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                      <button
                        disabled={!allow?.write}
                        onClick={() => {
                          change({
                            ...graph,
                            nodes: graph.nodes
                              .filter((n) => n.id !== selected.id)
                              .map((n) => {
                                const copy = { ...n };
                                for (const [port, target] of edges(n))
                                  if (target === selected.id) Object.assign(copy, { [port]: "" });
                                return copy;
                              }),
                          });
                          setSelectedId("");
                        }}
                      >
                        Delete block
                      </button>
                    </>
                  )}
                </aside>
              </div>
              {issues.length > 0 && (
                <details className={styles.validation}>
                  <summary>{issues.length} graph issue(s)</summary>
                  <ul>
                    {issues.map((issue, i) => (
                      <li key={i}>
                        {issue.nodeId ? `${issue.nodeId}: ` : ""}
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className={styles.sections}>
                <section>
                  <h2>Preview & run</h2>
                  <label>
                    Input JSON
                    <textarea
                      aria-label="Workflow input JSON"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      rows={4}
                    />
                  </label>
                  <label>
                    Environment
                    <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
                      <option value="">No environment</option>
                      {catalog?.environments.map((env) => (
                        <option key={env.id} value={env.id}>
                          {env.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <details open>
                    <summary>Request fixtures · preview sends no HTTP</summary>
                    <textarea
                      aria-label="Request fixtures JSON"
                      value={fixtures}
                      onChange={(e) => setFixtures(e.target.value)}
                      rows={4}
                    />
                    <button
                      onClick={() =>
                        setFixtures(
                          pretty(
                            Object.fromEntries(
                              graph.nodes
                                .filter((n) => n.type === "request")
                                .map((n) => [n.requestId, { status: 200, data: { ok: true }, headers: {} }]),
                            ),
                          ),
                        )
                      }
                    >
                      Fill sample fixtures
                    </button>
                  </details>
                  <div className={styles.actions}>
                    <button
                      disabled={busy || !!running || issues.length > 0}
                      onClick={() => void task(() => start(true))}
                    >
                      Preview fixtures
                    </button>
                    <button
                      disabled={busy || !!running || !allow?.run || issues.length > 0}
                      onClick={() => void task(() => start(false))}
                    >
                      <Play size={14} /> Run HTTP requests
                    </button>
                    {running && (
                      <button
                        disabled={!allow?.run || busy}
                        onClick={() =>
                          void task(async () => {
                            await call(`/api/workflow-runs/${run.id}/cancel`, "POST", {});
                          })
                        }
                      >
                        Cancel run
                      </button>
                    )}
                  </div>
                  <p>
                    Runs use the current canvas. HTTP runs may change remote systems. External input stays
                    literal in request bindings.
                  </p>
                  <details>
                    <summary>Run limits</summary>
                    {(["maxSteps", "maxDurationMs", "maxConcurrency"] as const).map((key) => (
                      <label key={key}>
                        {key}
                        <input
                          type="number"
                          value={graph.limits[key]}
                          disabled={!allow?.write}
                          onChange={(e) =>
                            change({ ...graph, limits: { ...graph.limits, [key]: Number(e.target.value) } })
                          }
                        />
                      </label>
                    ))}
                    <label>
                      <input
                        type="checkbox"
                        checked={graph.persistVariables}
                        disabled={!allow?.write}
                        onChange={(e) => change({ ...graph, persistVariables: e.target.checked })}
                      />{" "}
                      Persist script variable changes (serial loops only)
                    </label>
                  </details>
                </section>
                <section>
                  <h2>Results & trace</h2>
                  {run ? (
                    <>
                      <p role="status">
                        <strong>{run.status}</strong> · {run.steps} steps · {run.durationMs} ms
                        {run.version ? ` · v${run.version}` : ` · draft revision ${run.sourceRevision}`}
                      </p>
                      {run.error && <p className={styles.error}>{run.error}</p>}
                      <pre aria-label="Workflow output">{pretty(run.output)}</pre>
                      {run.traceOmitted > 0 && (
                        <p>
                          Trace retention limit reached: {run.traceOmitted} events omitted. Execution output
                          is retained separately.
                        </p>
                      )}
                      <div className={styles.trace}>
                        {run.trace?.map((event, i) => (
                          <button key={`${event.path}-${event.step}`} onClick={() => setTraceIndex(i)}>
                            #{event.step} {event.label} · {event.status}
                            {event.handled ? " (handled)" : ""} <small>{event.path}</small>
                          </button>
                        ))}
                      </div>
                      {traceIndex !== null && run.trace?.[traceIndex] && (
                        <pre aria-label="Step trace">{pretty(run.trace[traceIndex])}</pre>
                      )}
                      <details>
                        <summary>Run provenance</summary>
                        <code>{run.contentHash}</code>
                      </details>
                    </>
                  ) : (
                    <p>Preview or run a workflow to inspect each block’s data and output.</p>
                  )}
                  <h3>Recent runs</h3>
                  <div className={styles.trace}>
                    {history.map((h) => (
                      <button
                        key={h.id}
                        onClick={() =>
                          void task(async () => {
                            setRun(await call<Run>(`/api/workflow-runs/${h.id}`));
                            setTraceIndex(null);
                          })
                        }
                      >
                        {h.status} · {h.source} · {h.steps} steps
                      </button>
                    ))}
                  </div>
                </section>
                <section>
                  <h2>Versions & deployments</h2>
                  <button
                    disabled={busy || dirty || !allow?.manage}
                    onClick={() =>
                      void task(async () => {
                        const value = await call<{ version: number }>(
                          `/api/workflows/${workflow.id}/versions`,
                          "POST",
                          { revision: workflow.revision },
                        );
                        const next = await call<Workflow>(`/api/workflows/${workflow.id}`);
                        setWorkflow(next);
                        await refresh(workflow.id);
                        setVersion(value.version);
                        setNotice(`Published immutable version ${value.version}`);
                      })
                    }
                  >
                    Publish saved version
                  </button>
                  <p>
                    Versions pin request content and subflows. Secrets, policy and execution permissions are
                    checked live.
                  </p>
                  {workflow.versions.map((v) => (
                    <div key={v.version} className={styles.version}>
                      <span>
                        v{v.version}
                        {v.readable ? "" : " · key unavailable"}
                      </span>
                      <button
                        disabled={busy || !allow?.write}
                        onClick={() => {
                          if (abandon())
                            void task(async () => {
                              const value = await call<{ graph: FlowGraph }>(
                                `/api/workflows/${workflow.id}/versions/${v.version}`,
                              );
                              change(value.graph);
                              setSelectedId(value.graph.entry);
                            });
                        }}
                      >
                        Load graph
                      </button>
                      <button
                        disabled={busy || !allow?.manage}
                        onClick={() => {
                          if (
                            window.confirm(`Delete version ${v.version}? Deployments must be removed first.`)
                          )
                            void task(async () => {
                              await call(`/api/workflows/${workflow.id}/versions/${v.version}`, "DELETE");
                              setWorkflow(await call<Workflow>(`/api/workflows/${workflow.id}`));
                            });
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                  <h3>Deployments</h3>
                  <button disabled={!allow?.manage} onClick={() => editDeployment(null)}>
                    New deployment
                  </button>
                  {deployments.map((d) => (
                    <button key={d.id} onClick={() => editDeployment(d)}>
                      {d.name} · v{d.version} · {d.enabled ? "Enabled" : "Disabled"}
                    </button>
                  ))}
                  <fieldset disabled={busy || !allow?.manage}>
                    <legend>{deployment ? "Edit deployment" : "Create deployment"}</legend>
                    <label>
                      Deployment name
                      <input value={deploymentName} onChange={(e) => setDeploymentName(e.target.value)} />
                    </label>
                    <label>
                      Published version
                      <select
                        aria-label="Deployment version"
                        value={version}
                        onChange={(e) => setVersion(Number(e.target.value))}
                      >
                        <option value={0}>Choose version</option>
                        {workflow.versions.map((v) => (
                          <option key={v.version} value={v.version}>
                            v{v.version}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Deployment environment
                      <select
                        value={deploymentEnvironment}
                        onChange={(e) => setDeploymentEnvironment(e.target.value)}
                      >
                        <option value="">No environment</option>
                        {catalog?.environments.map((env) => (
                          <option key={env.id} value={env.id}>
                            {env.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      UTC schedule (five-field cron)
                      <input
                        aria-label="Workflow cron"
                        placeholder="*/15 * * * *"
                        value={cron}
                        onChange={(e) => setCron(e.target.value)}
                      />
                    </label>
                    <label>
                      Scheduled / manual input JSON
                      <textarea
                        value={deployInput}
                        onChange={(e) => setDeployInput(e.target.value)}
                        rows={3}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => setEnabled(e.target.checked)}
                      />{" "}
                      Deployment enabled
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={webhookEnabled}
                        onChange={(e) => setWebhookEnabled(e.target.checked)}
                      />{" "}
                      Bearer webhook enabled
                    </label>
                    <button
                      disabled={!workflow.versions.length || !version}
                      onClick={() =>
                        void task(async () => {
                          const fields = {
                            name: deploymentName,
                            version,
                            environmentId: deploymentEnvironment || null,
                            input: JSON.parse(deployInput),
                            enabled,
                            webhookEnabled,
                            cron: cron.trim() || null,
                          };
                          const value = await call<Deployment & { token?: string }>(
                            deployment
                              ? `/api/workflow-deployments/${deployment.id}`
                              : `/api/workflows/${workflow.id}/deployments`,
                            deployment ? "PUT" : "POST",
                            { ...fields, ...(deployment ? { revision: deployment.revision } : {}) },
                          );
                          editDeployment(value);
                          captureToken(value);
                          await refresh(workflow.id);
                          setNotice("Deployment saved");
                        })
                      }
                    >
                      Save deployment
                    </button>
                  </fieldset>
                  {deployment && (
                    <>
                      <p>
                        Runs as{" "}
                        {deployment.actor.kind === "user"
                          ? `account ${deployment.actor.userId}${deployment.actor.tokenId ? " through its API key" : ""}`
                          : deployment.actor.kind}
                        . Saving adopts your current identity and cancels its in-flight runs; adopting a
                        different identity invalidates the old webhook token.
                      </p>
                      {deployment.nextRun && <p>Next UTC tick: {deployment.nextRun}</p>}
                      {deployment.lastError && <p className={styles.error}>{deployment.lastError}</p>}
                      <div className={styles.actions}>
                        <button
                          disabled={busy || !allow?.run || !deployment.enabled}
                          onClick={() =>
                            void task(async () => {
                              const value = await call<{ runId: string }>(
                                `/api/workflow-deployments/${deployment.id}/run`,
                                "POST",
                                {},
                              );
                              setRun(await call<Run>(`/api/workflow-runs/${value.runId}`));
                              setTraceIndex(null);
                            })
                          }
                        >
                          Run deployed version
                        </button>
                        <button
                          disabled={busy || !allow?.manage}
                          onClick={() =>
                            void task(async () => {
                              const value = await call<Deployment & { token: string }>(
                                `/api/workflow-deployments/${deployment.id}/token`,
                                "POST",
                                { revision: deployment.revision },
                              );
                              editDeployment(value);
                              captureToken(value);
                              await refresh(workflow.id);
                            })
                          }
                        >
                          Rotate webhook token
                        </button>
                        <button
                          disabled={busy || !allow?.manage || deployment.enabled}
                          onClick={() => {
                            if (window.confirm("Delete this disabled deployment?"))
                              void task(async () => {
                                await call(`/api/workflow-deployments/${deployment.id}`, "DELETE");
                                editDeployment(null);
                                await refresh(workflow.id);
                              });
                          }}
                        >
                          Delete deployment
                        </button>
                      </div>
                    </>
                  )}
                  {token && (
                    <div className={styles.token}>
                      <strong>Copy this webhook token now. It is shown once.</strong>
                      <label>
                        Webhook token
                        <input aria-label="Webhook token" readOnly value={token.token} />
                      </label>
                      <code>{token.endpoint}</code>
                      <p>
                        POST JSON with Authorization: Bearer TOKEN. Use Idempotency-Key for retries. Add
                        ?wait=1 to wait up to 25 seconds; a 202 response contains a runId to poll at{" "}
                        {token.endpoint}/runs/RUN_ID with the same bearer token.
                      </p>
                      <button onClick={() => setToken(null)}>Dismiss token</button>
                    </div>
                  )}
                </section>
              </div>
              <details className={styles.graphJson}>
                <summary>Import / export graph JSON</summary>
                <p>
                  Copy JSON to export, or paste and apply a graph. Imported references must belong to this
                  workspace.
                </p>
                <textarea
                  aria-label="Graph JSON"
                  rows={12}
                  value={graphText}
                  onChange={(e) => setGraphText(e.target.value)}
                />
                <button
                  disabled={!allow?.write}
                  onClick={() =>
                    void task(async () => {
                      const next = parseGraph(JSON.parse(graphText));
                      change(next);
                      setSelectedId(next.entry);
                    })
                  }
                >
                  Apply graph JSON
                </button>
              </details>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
function JsonEditor({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(pretty(value)),
    [error, setError] = useState("");
  return (
    <fieldset disabled={disabled}>
      <legend>{label}</legend>
      <textarea
        aria-label={`${label} JSON`}
        value={text}
        rows={5}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        onClick={() => {
          try {
            onChange(JSON.parse(text));
            setError("");
          } catch {
            setError("Enter valid JSON");
          }
        }}
      >
        Apply {label.toLowerCase()}
      </button>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
