/**
 * gRPC client for the server-side relay: unary and client/server/bidirectional streaming
 * calls against definitions supplied with the request. The target host is resolved and
 * checked against the host policy before connecting to the vetted address (TLS keeps the
 * original name for SNI and certificate checks), and environment proxies are disabled so
 * nothing can route around that check.
 */
import dns from "node:dns/promises";
import net from "node:net";
import * as grpc from "@grpc/grpc-js";
import { type HostPolicy, OPEN_POLICY } from "../http/policy";
import { decodeMessage, encodeMessage, ProtoError, resolveMethod, type GrpcMethodInfo } from "./proto";
import type protobuf from "protobufjs";

export const MAX_GRPC_RESPONSE_MESSAGES = 1000;
export const MAX_GRPC_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_GRPC_MESSAGE_BYTES = 4 * 1024 * 1024;

export type GrpcMetadata = [string, string][];

export type GrpcEvent =
  | { type: "open"; target: string; method: GrpcMethodInfo; at: number }
  | { type: "sent"; index: number; message: unknown; at: number }
  | { type: "metadata"; metadata: GrpcMetadata; at: number }
  | { type: "message"; index: number; message: unknown; size: number; at: number }
  | { type: "status"; code: number; codeName: string; details: string; trailers: GrpcMetadata; at: number }
  | { type: "error"; error: string; at: number }
  | { type: "done"; at: number };

export interface GrpcCallInput {
  /** grpc://host[:port] (plaintext) or grpcs://host[:port] (TLS). */
  url: string;
  root: protobuf.Root;
  service: string;
  method: string;
  /** JSON messages. Unary and server-streaming calls take exactly one. */
  messages: unknown[];
  metadata: GrpcMetadata;
  verifySsl: boolean;
  timeoutMs: number;
  /**
   * Keep the request stream open after `messages` so more can be sent, then ended, through
   * the returned connection. Only for client-streaming and bidirectional methods.
   */
  interactive?: boolean;
}

/** Control of a running call: send more messages, half-close the request stream, or cancel. */
export interface GrpcConnection {
  send(message: unknown): void;
  end(): void;
  cancel(): void;
}

export const MAX_GRPC_SENT_MESSAGES = 10_000;
export const MAX_GRPC_SENT_BYTES = 16 * 1024 * 1024;

/** Headers that belong to HTTP, not gRPC metadata, or that gRPC sets itself. */
const RESERVED = new Set([
  "host",
  "connection",
  "content-length",
  "content-type",
  "te",
  "user-agent",
  "accept",
  "accept-encoding",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-connection",
]);

export function buildMetadata(headers: GrpcMetadata): grpc.Metadata {
  const md = new grpc.Metadata();
  for (const [rawKey, value] of headers) {
    const key = rawKey.trim().toLowerCase();
    if (!key || key.startsWith(":") || key.startsWith("grpc-") || RESERVED.has(key)) continue;
    try {
      md.add(key, key.endsWith("-bin") ? Buffer.from(value, "base64") : value);
    } catch (err) {
      throw new ProtoError(`Invalid metadata "${rawKey}": ${(err as Error).message}`);
    }
  }
  return md;
}

export const flattenMetadata = (md: grpc.Metadata): GrpcMetadata => {
  const out: GrpcMetadata = [];
  for (const key of Object.keys(md.getMap()))
    for (const v of md.get(key)) out.push([key, Buffer.isBuffer(v) ? v.toString("base64") : String(v)]);
  return out;
};

function parseTarget(url: URL): { tls: boolean; hostname: string; port: number } {
  if (url.protocol !== "grpc:" && url.protocol !== "grpcs:")
    throw new ProtoError("gRPC URLs must start with grpc:// or grpcs://");
  const tls = url.protocol === "grpcs:";
  return {
    tls,
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port) || (tls ? 443 : 80),
  };
}

export interface GrpcTarget {
  url: URL;
  tls: boolean;
  hostname: string;
  /** One grpc-js target per resolved address, in resolver order. */
  targets: string[];
}

/** Parse the URL and resolve the host; every resolved address must pass the host policy. */
export async function resolveGrpcTarget(rawUrl: string, policy: HostPolicy): Promise<GrpcTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProtoError(`Invalid URL: ${rawUrl}`);
  }
  const { tls, hostname, port } = parseTarget(url);
  policy.assert(hostname);
  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await dns.lookup(hostname, { all: true })).map((a) => a.address);
  // Every candidate must pass the policy, not just the one tried first.
  for (const address of addresses) policy.assert(hostname, address);
  const targets = addresses.map((a) => (net.isIPv6(a) ? `ipv6:[${a}]:${port}` : `ipv4:${a}:${port}`));
  return { url, tls, hostname, targets };
}

export function grpcCredentials(t: GrpcTarget, verifySsl: boolean): grpc.ChannelCredentials {
  return t.tls
    ? grpc.credentials.createSsl(null, null, null, { rejectUnauthorized: verifySsl })
    : grpc.credentials.createInsecure();
}

/** Channel settings that keep TLS names right and stop environment proxies bypassing the policy. */
export function grpcChannelOptions(t: GrpcTarget): grpc.ChannelOptions {
  return {
    "grpc.enable_http_proxy": 0,
    "grpc.max_receive_message_length": MAX_GRPC_MESSAGE_BYTES,
    "grpc.max_send_message_length": MAX_GRPC_MESSAGE_BYTES,
    "grpc.default_authority": t.url.host,
    ...(t.tls && !net.isIP(t.hostname) ? { "grpc.ssl_target_name_override": t.hostname } : {}),
  };
}

/**
 * Start one call, reporting events as they happen. Rejects only for problems found before
 * connecting (bad URL, bad definitions, invalid messages, blocked host); otherwise resolves
 * with a promise that settles after the final "done" event.
 */
export async function startGrpcCall(
  input: GrpcCallInput,
  onEvent: (e: GrpcEvent) => void,
  opts: { policy?: HostPolicy; signal?: AbortSignal } = {},
): Promise<{ finished: Promise<void>; connection: GrpcConnection }> {
  const policy = opts.policy ?? OPEN_POLICY;
  const { info, request, response } = resolveMethod(input.root, input.service, input.method);

  if (input.interactive && !info.clientStreaming)
    throw new ProtoError(`${info.name} does not stream from the client, so it cannot be interactive`);
  if (!info.clientStreaming && input.messages.length !== 1)
    throw new ProtoError(`${info.name} takes exactly one request message`);
  // Encode everything first so a bad message fails before any connection is made.
  const encoded = input.messages.map((m) => encodeMessage(request, m));
  for (const buf of encoded)
    if (buf.length > MAX_GRPC_MESSAGE_BYTES)
      throw new ProtoError(`Messages are limited to ${MAX_GRPC_MESSAGE_BYTES} bytes`);
  const metadata = buildMetadata(input.metadata);

  const target = await resolveGrpcTarget(input.url, policy);
  const { url, targets } = target;
  const credentials = grpcCredentials(target, input.verifySsl);
  const channelOptions = grpcChannelOptions(target);

  const now = () => Date.now();
  // One absolute deadline covers every address tried.
  const callOptions: grpc.CallOptions = { deadline: new Date(Date.now() + input.timeoutMs) };
  const serialize = (b: Buffer) => b;
  const deserialize = (b: Buffer) => b;

  // Messages written so far, replayed if the first address cannot be reached. Dropped once
  // the server has answered, because no other address is tried after that.
  const buffered: Buffer[] = [...encoded];
  let bufferedBytes = encoded.reduce((n, b) => n + b.length, 0);
  let sentCount = 0;
  let ended = !input.interactive;
  let writable: grpc.ClientWritableStream<Buffer> | grpc.ClientDuplexStream<Buffer, Buffer> | undefined;
  let activeCall: { cancel(): void } | undefined;
  let isSettled = () => false;
  const nextSentIndex = () => sentCount++;

  const finished = new Promise<void>((resolve) => {
    let settled = false;
    isSettled = () => settled;
    let received = 0;
    let receivedBytes = 0;
    let heardFromServer = false;
    let client: grpc.Client | undefined;
    let call:
      | grpc.ClientUnaryCall
      | grpc.ClientReadableStream<Buffer>
      | grpc.ClientWritableStream<Buffer>
      | grpc.ClientDuplexStream<Buffer, Buffer>
      | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      client?.close();
      onEvent({ type: "done", at: now() });
      resolve();
    };
    const onAbort = () => call?.cancel();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const onMessage = (buf: Buffer) => {
      if (settled) return;
      heardFromServer = true;
      buffered.length = 0;
      received++;
      receivedBytes += buf.length;
      if (received > MAX_GRPC_RESPONSE_MESSAGES || receivedBytes > MAX_GRPC_RESPONSE_BYTES) {
        onEvent({ type: "error", error: "Response limit exceeded; call cancelled", at: now() });
        call?.cancel();
        return;
      }
      try {
        onEvent({
          type: "message",
          index: received - 1,
          message: decodeMessage(response, buf),
          size: buf.length,
          at: now(),
        });
      } catch (err) {
        onEvent({ type: "error", error: `Could not decode response: ${(err as Error).message}`, at: now() });
        call?.cancel();
      }
    };

    /** Start the call against one resolved address. */
    const attempt = (index: number) => {
      client = new grpc.Client(targets[index], credentials, channelOptions);
      const path = info.path;
      if (info.clientStreaming && info.serverStreaming) {
        const duplex = client.makeBidiStreamRequest(path, serialize, deserialize, metadata, callOptions);
        duplex.on("data", onMessage);
        call = duplex;
      } else if (info.clientStreaming) {
        call = client.makeClientStreamRequest(
          path,
          serialize,
          deserialize,
          metadata,
          callOptions,
          (err, value) => {
            if (!err && value) onMessage(value as Buffer);
          },
        );
      } else if (info.serverStreaming) {
        const readable = client.makeServerStreamRequest(
          path,
          serialize,
          deserialize,
          encoded[0],
          metadata,
          callOptions,
        );
        readable.on("data", onMessage);
        call = readable;
      } else {
        call = client.makeUnaryRequest(
          path,
          serialize,
          deserialize,
          encoded[0],
          metadata,
          callOptions,
          (err, value) => {
            if (!err && value) onMessage(value as Buffer);
          },
        );
      }

      call.on("metadata", (md: grpc.Metadata) => {
        heardFromServer = true;
        buffered.length = 0;
        onEvent({ type: "metadata", metadata: flattenMetadata(md), at: now() });
      });
      // Failures arrive as a status; the listener only stops Node treating them as uncaught.
      (call as NodeJS.EventEmitter).on("error", () => undefined);
      call.on("status", (s: grpc.StatusObject) => {
        // No connection could be made, so nothing reached a server: try the next address
        // (for example a name that resolves to ::1 first while the server listens on IPv4).
        if (
          s.code === grpc.status.UNAVAILABLE &&
          s.details.startsWith("No connection established") &&
          !heardFromServer &&
          index + 1 < targets.length &&
          !opts.signal?.aborted
        ) {
          client?.close();
          attempt(index + 1);
          return;
        }
        onEvent({
          type: "status",
          code: s.code,
          codeName: grpc.status[s.code] ?? String(s.code),
          details: s.details,
          trailers: flattenMetadata(s.metadata),
          at: now(),
        });
        finish();
      });

      activeCall = call;
      if (info.clientStreaming) {
        const stream = call as grpc.ClientWritableStream<Buffer>;
        writable = stream;
        for (const buf of buffered) stream.write(buf);
        if (index === 0)
          input.messages.forEach((message) =>
            onEvent({ type: "sent", index: nextSentIndex(), message, at: now() }),
          );
        if (ended) stream.end();
      }
    };

    onEvent({ type: "open", target: url.host, method: info, at: now() });
    if (opts.signal?.aborted) {
      finish();
      return;
    }
    attempt(0);
  });
  const connection: GrpcConnection = {
    send(message) {
      if (isSettled()) throw new ProtoError("The call has finished");
      if (!info.clientStreaming || ended)
        throw new ProtoError("The request stream is closed; no more messages can be sent");
      const buf = encodeMessage(request, message);
      if (buf.length > MAX_GRPC_MESSAGE_BYTES)
        throw new ProtoError(`Messages are limited to ${MAX_GRPC_MESSAGE_BYTES} bytes`);
      if (sentCount >= MAX_GRPC_SENT_MESSAGES || bufferedBytes + buf.length > MAX_GRPC_SENT_BYTES)
        throw new ProtoError("Too many messages sent on this call");
      bufferedBytes += buf.length;
      buffered.push(buf);
      writable?.write(buf);
      onEvent({ type: "sent", index: nextSentIndex(), message, at: now() });
    },
    end() {
      if (isSettled() || ended) return;
      ended = true;
      writable?.end();
    },
    cancel() {
      activeCall?.cancel();
    },
  };
  return { finished, connection };
}

/** Run a call to completion. */
export async function runGrpcCall(
  input: GrpcCallInput,
  onEvent: (e: GrpcEvent) => void,
  opts: { policy?: HostPolicy; signal?: AbortSignal } = {},
): Promise<void> {
  await (
    await startGrpcCall(input, onEvent, opts)
  ).finished;
}
