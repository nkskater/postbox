/**
 * MQTT 3.1.1 / 5 client for the server-side relay. The broker host is resolved
 * and checked against the host policy before connecting to the vetted address
 * (TLS keeps the original name for SNI and certificate checks).
 */
import dns from "node:dns/promises";
import net from "node:net";
import mqtt, { type MqttClient } from "mqtt";
import type { MqttSettings, PreparedRequest } from "../types";
import { type HostPolicy, OPEN_POLICY } from "../http/policy";

export const MAX_MQTT_PAYLOAD_BYTES = 1024 * 1024;
export type Qos = 0 | 1 | 2;

export type MqttEvent =
  | { type: "open"; clientId: string; at: number }
  | {
      type: "message";
      topic: string;
      payload: string;
      binary: boolean;
      qos: number;
      retain: boolean;
      size: number;
      at: number;
    }
  | { type: "published"; topic: string; payload: string; qos: number; retain: boolean; at: number }
  | { type: "subscribed"; topic: string; qos: number; granted: number; at: number }
  | { type: "unsubscribed"; topic: string; at: number }
  | { type: "error"; error: string; at: number }
  | { type: "close"; reason: string; at: number };

export interface MqttConnection {
  publish(
    topic: string,
    payload: string,
    opts?: { qos?: Qos; retain?: boolean; binary?: boolean },
  ): Promise<void>;
  subscribe(topic: string, qos?: Qos): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  close(): void;
}

const isUtf8Text = (buf: Buffer) => {
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) && !/[\u0000-\u0008\u000e-\u001f]/.test(text);
};

/** Topic filters: no empty levels mixed with wildcards in the wrong places. */
export function validTopicFilter(topic: string): boolean {
  if (!topic || topic.length > 65535 || topic.includes("\0")) return false;
  const levels = topic.split("/");
  return levels.every((l, i) =>
    l.includes("#") ? l === "#" && i === levels.length - 1 : !l.includes("+") || l === "+",
  );
}

export async function connectMqtt(
  prepared: PreparedRequest,
  cfg: MqttSettings,
  credentials: { username?: string; password?: string },
  onEvent: (e: MqttEvent) => void,
  opts: { policy?: HostPolicy; signal?: AbortSignal } = {},
): Promise<MqttConnection> {
  const policy = opts.policy ?? OPEN_POLICY;
  const url = new URL(prepared.url);
  if (url.protocol !== "mqtt:" && url.protocol !== "mqtts:")
    throw new Error("MQTT URLs must start with mqtt:// or mqtts://");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  policy.assert(hostname);
  const address = net.isIP(hostname) ? hostname : (await dns.lookup(hostname)).address;
  policy.assert(hostname, address);
  const tls = url.protocol === "mqtts:";
  const now = () => Date.now();
  let closed = false;

  const client: MqttClient = mqtt.connect({
    protocol: tls ? "mqtts" : "mqtt",
    host: address,
    port: Number(url.port) || (tls ? 8883 : 1883),
    ...(tls
      ? {
          servername: net.isIP(hostname) ? undefined : hostname,
          rejectUnauthorized: prepared.settings.verifySsl,
        }
      : {}),
    protocolVersion: cfg.protocolVersion ?? 4,
    clientId: cfg.clientId?.trim() || `postbox-${Math.random().toString(16).slice(2, 10)}`,
    clean: cfg.clean ?? true,
    keepalive: cfg.keepalive ?? 60,
    connectTimeout: prepared.settings.timeoutMs,
    reconnectPeriod: 0,
    ...(credentials.username ? { username: credentials.username } : {}),
    ...(credentials.password ? { password: credentials.password } : {}),
  });
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    opts.signal?.removeEventListener("abort", onAbort);
    onEvent({ type: "close", reason, at: now() });
  };
  client.on("connect", () => onEvent({ type: "open", clientId: client.options.clientId ?? "", at: now() }));
  client.on("message", (topic, payload, packet) => {
    const buf =
      payload.length > MAX_MQTT_PAYLOAD_BYTES ? payload.subarray(0, MAX_MQTT_PAYLOAD_BYTES) : payload;
    const text = isUtf8Text(buf);
    onEvent({
      type: "message",
      topic,
      payload: text ? buf.toString("utf8") : buf.toString("base64"),
      binary: !text,
      qos: packet.qos,
      retain: packet.retain,
      size: payload.length,
      at: now(),
    });
  });
  client.on("error", (err) => {
    onEvent({ type: "error", error: err.message, at: now() });
    client.end(true);
    finish("Connection failed");
  });
  client.on("close", () => finish("Disconnected"));
  const onAbort = () => {
    client.end(true);
    finish("Closed by client");
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const ready = () => {
    if (!client.connected) throw new Error("MQTT is not connected");
  };
  const conn: MqttConnection = {
    async publish(topic, payload, o = {}) {
      ready();
      if (!topic || /[#+\0]/.test(topic))
        throw new Error("Publish topics cannot be empty or contain wildcards");
      const body = o.binary ? Buffer.from(payload, "base64") : Buffer.from(payload, "utf8");
      if (body.length > MAX_MQTT_PAYLOAD_BYTES)
        throw new Error(`Payloads are limited to ${MAX_MQTT_PAYLOAD_BYTES} bytes`);
      const qos = o.qos ?? 0;
      await client.publishAsync(topic, body, { qos, retain: o.retain ?? false });
      onEvent({ type: "published", topic, payload, qos, retain: o.retain ?? false, at: now() });
    },
    async subscribe(topic, qos = 0) {
      ready();
      if (!validTopicFilter(topic)) throw new Error(`Invalid topic filter "${topic}"`);
      const granted = await client.subscribeAsync(topic, { qos });
      const g = granted[0]?.qos ?? 128;
      if (g === 128) throw new Error(`Broker refused the subscription to "${topic}"`);
      onEvent({ type: "subscribed", topic, qos, granted: g, at: now() });
    },
    async unsubscribe(topic) {
      ready();
      await client.unsubscribeAsync(topic);
      onEvent({ type: "unsubscribed", topic, at: now() });
    },
    close() {
      client.end(true);
      finish("Closed by client");
    },
  };
  // Saved subscriptions are restored once connected.
  client.once("connect", () => {
    for (const s of cfg.subscriptions ?? [])
      conn
        .subscribe(s.topic, (s.qos ?? 0) as Qos)
        .catch((err: Error) => onEvent({ type: "error", error: err.message, at: now() }));
  });
  return conn;
}
