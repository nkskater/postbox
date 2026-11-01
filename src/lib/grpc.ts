/** Helpers shared by the gRPC editor and panel: URL detection, method labels, event log entries. */
import type { GrpcSettings } from "@/core/types";

export interface GrpcMethodSummary {
  name: string;
  path: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
}

export interface GrpcServiceSummary {
  name: string;
  fullName: string;
  methods: GrpcMethodSummary[];
}

export const isGrpcUrl = (url: string) => /^grpcs?:\/\//i.test(url.trim());

export function streamingKind(m: Pick<GrpcMethodSummary, "clientStreaming" | "serverStreaming">) {
  if (m.clientStreaming && m.serverStreaming) return "bidirectional streaming";
  if (m.clientStreaming) return "client streaming";
  if (m.serverStreaming) return "server streaming";
  return "unary";
}

/** Flat, sorted options for a method picker: "pkg.Service/Method". */
export function methodOptions(services: GrpcServiceSummary[]) {
  return services.flatMap((s) =>
    s.methods.map((m) => ({
      value: `${s.fullName}/${m.name}`,
      service: s.fullName,
      method: m.name,
      label: `${s.fullName}/${m.name}`,
      kind: streamingKind(m),
      info: m,
    })),
  );
}

export const emptyGrpc = (): GrpcSettings => ({ protos: {}, service: "", method: "" });

/** Rename a proto file keeping its position; a clashing or empty name is rejected. */
export function renameProto(
  protos: Record<string, string>,
  from: string,
  to: string,
): Record<string, string> {
  const name = to.trim();
  if (!name || (name !== from && name in protos)) return protos;
  return Object.fromEntries(Object.entries(protos).map(([k, v]) => [k === from ? name : k, v]));
}

/** A new unique file name such as "service.proto", "service-2.proto". */
export function nextProtoName(protos: Record<string, string>, base = "service"): string {
  if (!(`${base}.proto` in protos)) return `${base}.proto`;
  for (let i = 2; ; i++) if (!(`${base}-${i}.proto` in protos)) return `${base}-${i}.proto`;
}

export type GrpcWireEvent =
  | { type: "session"; id: string }
  | { type: "open"; target: string; method: GrpcMethodSummary; at: number }
  | { type: "sent"; index: number; message: unknown; at: number }
  | { type: "metadata"; metadata: [string, string][]; at: number }
  | { type: "message"; index: number; message: unknown; size: number; at: number }
  | {
      type: "status";
      code: number;
      codeName: string;
      details: string;
      trailers: [string, string][];
      at: number;
    }
  | { type: "error"; error: string; at?: number }
  | { type: "done"; at: number };

export interface GrpcLogEntry {
  kind: "in" | "out" | "info" | "error";
  title: string;
  text: string;
  at: number;
}

const pairs = (list: [string, string][]) => list.map(([k, v]) => `${k}: ${v}`).join("\n");

/** One log row for an event; null for events that only carry state (session). */
export function logEntry(e: GrpcWireEvent): GrpcLogEntry | null {
  switch (e.type) {
    case "session":
      return null;
    case "open":
      return {
        kind: "info",
        title: "Call",
        text: `${e.method.path} on ${e.target} (${streamingKind(e.method)})`,
        at: e.at,
      };
    case "sent":
      return {
        kind: "out",
        title: `Sent #${e.index + 1}`,
        text: JSON.stringify(e.message, null, 2),
        at: e.at,
      };
    case "metadata":
      return { kind: "info", title: "Response metadata", text: pairs(e.metadata), at: e.at };
    case "message":
      return {
        kind: "in",
        title: `Message #${e.index + 1}`,
        text: JSON.stringify(e.message, null, 2),
        at: e.at,
      };
    case "status": {
      const ok = e.code === 0;
      const detail = ok || !e.details ? "" : `: ${e.details}`;
      return {
        kind: ok ? "info" : "error",
        title: "Status",
        text: `${e.codeName} (${e.code})${detail}${e.trailers.length ? `\n${pairs(e.trailers)}` : ""}`,
        at: e.at,
      };
    }
    case "error":
      return { kind: "error", title: "Error", text: e.error, at: e.at ?? Date.now() };
    case "done":
      return { kind: "info", title: "Done", text: "Call finished", at: e.at };
  }
}
