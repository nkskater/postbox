/**
 * gRPC server reflection client: lists a server's services and downloads their file
 * descriptors (with dependencies) so methods can be called without local .proto files.
 * Tries the v1 service first and falls back to v1alpha. Uses the same host-policy checks,
 * address fallback, TLS, metadata, deadline and cancellation rules as calls.
 */
import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";
import "protobufjs/ext/descriptor";
import { type HostPolicy, OPEN_POLICY } from "../http/policy";
import {
  buildMetadata,
  grpcChannelOptions,
  grpcCredentials,
  resolveGrpcTarget,
  type GrpcMetadata,
} from "./client";
import { ProtoError } from "./proto";

export const MAX_REFLECTION_FILES = 200;
export const MAX_REFLECTION_BYTES = 8 * 1024 * 1024;

const REFLECTION_PROTO = (version: "v1" | "v1alpha") => `
syntax = "proto3";
package grpc.reflection.${version};
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}
message ServerReflectionResponse {
  string valid_host = 1;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;

export interface ReflectionInput {
  url: string;
  metadata: GrpcMetadata;
  verifySsl: boolean;
  timeoutMs: number;
}

interface ReflectionResponse {
  file_descriptor_response?: { file_descriptor_proto: Buffer[] };
  list_services_response?: { service: { name: string }[] };
  error_response?: { error_code: number; error_message: string };
}

/** The descriptor extension adds these at runtime without typings. */
const FileDescriptorProto = (
  protobuf as unknown as {
    descriptor: {
      FileDescriptorProto: { decode(b: Uint8Array): { name: string; dependency: string[] } };
    };
  }
).descriptor.FileDescriptorProto;

/** Thrown when the server has no reflection service of the version tried. */
class ReflectionUnimplemented extends Error {}

export function protoFor(version: "v1" | "v1alpha") {
  const root = new protobuf.Root();
  protobuf.parse(REFLECTION_PROTO(version), root, { keepCase: true });
  return {
    path: `/grpc.reflection.${version}.ServerReflection/ServerReflectionInfo`,
    request: root.lookupType(`grpc.reflection.${version}.ServerReflectionRequest`),
    response: root.lookupType(`grpc.reflection.${version}.ServerReflectionResponse`),
  };
}

/** Wrap a file descriptor as a one-file FileDescriptorSet entry (field 1, length-delimited). */
function setEntry(file: Uint8Array): Buffer {
  const writer = protobuf.Writer.create();
  writer.uint32((1 << 3) | 2).bytes(file);
  return Buffer.from(writer.finish());
}

async function reflectWith(
  version: "v1" | "v1alpha",
  client: grpc.Client,
  input: ReflectionInput,
  signal: AbortSignal | undefined,
): Promise<protobuf.Root> {
  const proto = protoFor(version);
  const stream = client.makeBidiStreamRequest(
    proto.path,
    (m: Buffer) => m,
    (b: Buffer) => b,
    buildMetadata(input.metadata),
    { deadline: new Date(Date.now() + input.timeoutMs) },
  );
  const pending: ((r: ReflectionResponse | Error) => void)[] = [];
  const queue: (ReflectionResponse | Error)[] = [];
  const deliver = (r: ReflectionResponse | Error) => {
    const waiter = pending.shift();
    if (waiter) waiter(r);
    else queue.push(r);
  };
  stream.on("data", (b: Buffer) =>
    deliver(proto.response.toObject(proto.response.decode(b), { oneofs: false }) as ReflectionResponse),
  );
  stream.on("error", (err: grpc.ServiceError) => {
    deliver(
      err.code === grpc.status.UNIMPLEMENTED
        ? new ReflectionUnimplemented()
        : new ProtoError(
            err.code === grpc.status.CANCELLED
              ? "Reflection was cancelled"
              : err.code === grpc.status.DEADLINE_EXCEEDED
                ? "Reflection timed out"
                : `Reflection failed (${grpc.status[err.code] ?? err.code}): ${err.details || err.message}`,
          ),
    );
  });
  stream.on("end", () => deliver(new ProtoError("Reflection ended unexpectedly")));
  const onAbort = () => stream.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });

  const ask = (message: Record<string, string>): Promise<ReflectionResponse> =>
    new Promise((resolve, reject) => {
      const settle = (r: ReflectionResponse | Error) => (r instanceof Error ? reject(r) : resolve(r));
      const queued = queue.shift();
      if (queued) return settle(queued);
      pending.push(settle);
      stream.write(
        Buffer.from(proto.request.encode(proto.request.fromObject({ host: "", ...message })).finish()),
      );
    });

  try {
    const files = new Map<string, Uint8Array>();
    let bytes = 0;
    const addFiles = (res: ReflectionResponse) => {
      for (const raw of res.file_descriptor_response?.file_descriptor_proto ?? []) {
        const fd = FileDescriptorProto.decode(raw);
        const name = fd.name;
        if (files.has(name)) continue;
        bytes += raw.length;
        if (files.size >= MAX_REFLECTION_FILES || bytes > MAX_REFLECTION_BYTES)
          throw new ProtoError("The server's reflection response is too large");
        files.set(name, raw);
      }
    };
    const dependenciesOf = (raw: Uint8Array) => FileDescriptorProto.decode(raw).dependency;
    const check = (res: ReflectionResponse, what: string) => {
      if (res.error_response)
        throw new ProtoError(`Reflection error for ${what}: ${res.error_response.error_message}`);
    };

    const listed = await ask({ list_services: "*" });
    check(listed, "the service list");
    const services = (listed.list_services_response?.service ?? [])
      .map((s) => s.name)
      .filter((n) => !n.startsWith("grpc.reflection."));
    if (services.length === 0) throw new ProtoError("The server reports no services");
    for (const name of services) {
      const res = await ask({ file_containing_symbol: name });
      check(res, name);
      addFiles(res);
    }
    // Fetch dependencies the server did not include alongside the requested symbols.
    for (let progressed = true; progressed;) {
      progressed = false;
      for (const raw of [...files.values()]) {
        for (const dep of dependenciesOf(raw)) {
          if (files.has(dep)) continue;
          const res = await ask({ file_by_filename: dep });
          check(res, dep);
          addFiles(res);
          progressed = true;
        }
      }
    }
    stream.end();
    const set = Buffer.concat([...files.values()].map(setEntry));
    try {
      const root = (
        protobuf.Root as unknown as { fromDescriptor(d: Uint8Array): protobuf.Root }
      ).fromDescriptor(set);
      root.resolveAll();
      return root;
    } catch (err) {
      throw new ProtoError(`Could not use the server's descriptors: ${(err as Error).message}`);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stream.cancel();
  }
}

/** Fetch the server's definitions by reflection as a protobuf root. */
export async function reflectRoot(
  input: ReflectionInput,
  opts: { policy?: HostPolicy; signal?: AbortSignal } = {},
): Promise<protobuf.Root> {
  const target = await resolveGrpcTarget(input.url, opts.policy ?? OPEN_POLICY);
  const credentials = grpcCredentials(target, input.verifySsl);
  const channelOptions = grpcChannelOptions(target);
  let lastError: Error | undefined;
  for (const address of target.targets) {
    const client = new grpc.Client(address, credentials, channelOptions);
    try {
      for (const version of ["v1", "v1alpha"] as const) {
        try {
          return await reflectWith(version, client, input, opts.signal);
        } catch (err) {
          if (!(err instanceof ReflectionUnimplemented)) throw err;
          lastError = new ProtoError("The server does not support gRPC reflection");
        }
      }
    } catch (err) {
      // Unreachable address: try the next one. Anything else is final.
      if (err instanceof ProtoError && /No connection established/.test(err.message)) {
        lastError = err;
        continue;
      }
      throw err;
    } finally {
      client.close();
    }
    if (lastError) throw lastError;
  }
  throw lastError ?? new ProtoError("Could not connect");
}
