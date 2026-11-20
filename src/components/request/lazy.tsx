"use client";
/**
 * Request-editor parts that only some requests need (live protocols, gRPC, GraphQL, AI, contracts
 * and comments). Their code, and the libraries behind them (protobuf, graphql, ajv), loads when one
 * is first shown.
 */
import dynamic from "next/dynamic";

function Loading() {
  return <div className="h-1 w-16 animate-pulse rounded bg-muted" aria-busy="true" />;
}

export const ContractEditor = dynamic(
  () => import("@/components/request/ContractEditor").then((m) => m.ContractEditor),
  { ssr: false, loading: Loading },
);
export const AiPanel = dynamic(() => import("@/components/response/AiPanel").then((m) => m.AiPanel), {
  ssr: false,
  loading: Loading,
});
export const EventStreamPanel = dynamic(
  () => import("@/components/response/EventStreamPanel").then((m) => m.EventStreamPanel),
  { ssr: false, loading: Loading },
);
export const WebSocketPanel = dynamic(
  () => import("@/components/response/WebSocketPanel").then((m) => m.WebSocketPanel),
  { ssr: false, loading: Loading },
);
export const SocketIoPanel = dynamic(
  () => import("@/components/response/SocketIoPanel").then((m) => m.SocketIoPanel),
  { ssr: false, loading: Loading },
);
export const MqttPanel = dynamic(() => import("@/components/response/MqttPanel").then((m) => m.MqttPanel), {
  ssr: false,
  loading: Loading,
});
export const GrpcPanel = dynamic(() => import("@/components/response/GrpcPanel").then((m) => m.GrpcPanel), {
  ssr: false,
  loading: Loading,
});
export const GrpcEditor = dynamic(() => import("@/components/request/GrpcEditor").then((m) => m.GrpcEditor), {
  ssr: false,
  loading: Loading,
});
export const CommentsPanel = dynamic(
  () => import("@/components/comments/CommentsPanel").then((m) => m.CommentsPanel),
  { ssr: false, loading: Loading },
);
export const GraphqlBodyEditor = dynamic(
  () => import("@/components/request/GraphqlBodyEditor").then((m) => m.GraphqlBodyEditor),
  { ssr: false, loading: Loading },
);
