import { contractSchema } from "./contracts/model";
import { parseContract } from "./contracts/validate";
import { visualizationSchema } from "./visualizer/model";
/**
 * Runtime schemas for the domain model, shared by the REST API, the MCP server
 * and the script sandbox. Unknown keys are stripped; anything structurally wrong
 * is rejected before it reaches persistence or the HTTP engine.
 */
import { z } from "zod";
import type {
  AsapConfig,
  AuthConfig,
  AwsSigV4Config,
  BodyConfig,
  EdgeGridConfig,
  HawkConfig,
  OAuth1Config,
  OAuth2Config,
} from "./types";
import { base64ByteLength, MAX_UPLOAD_BYTES, MAX_UPLOAD_BASE64_CHARS } from "./retention";

/** RFC 9110 method token (custom methods such as PROPFIND or M-SEARCH are allowed). */
export const methodSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "Invalid HTTP method");

export const keyValueSchema = z.object({
  key: z.string(),
  value: z.string().default(""),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
});

export const formDataFieldSchema = keyValueSchema.extend({
  type: z.enum(["text", "file"]).default("text"),
  fileName: z.string().optional(),
  contentType: z.string().optional(),
  data: z.string().optional(),
  missing: z.boolean().optional(),
});

const bodyConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("raw"),
    raw: z.string(),
    language: z.enum(["json", "xml", "text", "html", "javascript"]).default("json"),
  }),
  z.object({ mode: z.literal("urlencoded"), urlencoded: z.array(keyValueSchema) }),
  z.object({ mode: z.literal("formdata"), formdata: z.array(formDataFieldSchema) }),
  z.object({
    mode: z.literal("binary"),
    binary: z
      .object({
        fileName: z.string(),
        contentType: z.string().optional(),
        data: z.string(),
        missing: z.boolean().optional(),
      })
      .nullable(),
  }),
  z.object({
    mode: z.literal("graphql"),
    graphql: z.object({
      query: z.string(),
      variables: z.string().default("{}"),
      operationName: z.string().optional(),
    }),
  }),
]);

export const bodySchema: z.ZodType<BodyConfig> = bodyConfigSchema.superRefine((body, ctx) => {
  const uploadChars =
    body.mode === "binary"
      ? (body.binary?.data.length ?? 0)
      : body.mode === "formdata"
        ? body.formdata.reduce(
            (total, field) => total + (field.type === "file" ? (field.data?.length ?? 0) : 0),
            0,
          )
        : 0;
  const upload =
    body.mode === "binary"
      ? body.binary
        ? base64ByteLength(body.binary.data)
        : 0
      : body.mode === "formdata"
        ? body.formdata.reduce(
            (total, field) => total + (field.type === "file" ? base64ByteLength(field.data ?? "") : 0),
            0,
          )
        : 0;
  if (upload > MAX_UPLOAD_BYTES || uploadChars > MAX_UPLOAD_BASE64_CHARS) {
    ctx.addIssue({ code: "custom", message: "Uploaded request files must total 5 MiB or less" });
  }
});

export const oauth2ConfigSchema: z.ZodType<OAuth2Config> = z.object({
  grantType: z.enum(["client_credentials", "password", "authorization_code", "manual"]),
  authUrl: z.string().optional(),
  redirectUri: z.string().optional(),
  revocationUrl: z.string().optional(),
  usePkce: z.boolean().optional(),
  codeChallengeMethod: z.enum(["S256", "plain"]).optional(),
  accessTokenUrl: z.string().default(""),
  clientId: z.string().default(""),
  clientSecret: z.string().default(""),
  scope: z.string().default(""),
  username: z.string().optional(),
  password: z.string().optional(),
  clientAuthentication: z.enum(["header", "body"]).default("header"),
  accessToken: z.string().default(""),
  refreshToken: z.string().optional(),
  tokenType: z.string().optional(),
  expiresAt: z.number().optional(),
  tokenContext: z.string().optional(),
  headerPrefix: z.string().default("Bearer"),
});

export const edgeGridConfigSchema: z.ZodType<EdgeGridConfig> = z.object({
  clientToken: z.string().default(""),
  clientSecret: z.string().default(""),
  accessToken: z.string().default(""),
  baseURL: z.string().optional(),
  headersToSign: z.string().optional(),
  maxBodySize: z.number().int().nonnegative().optional(),
  nonce: z.string().optional(),
  timestamp: z.string().optional(),
});
export const hawkConfigSchema: z.ZodType<HawkConfig> = z.object({
  authId: z.string().default(""),
  authKey: z.string().default(""),
  algorithm: z.enum(["sha256", "sha1"]).default("sha256"),
  user: z.string().optional(),
  nonce: z.string().optional(),
  ext: z.string().optional(),
  app: z.string().optional(),
  dlg: z.string().optional(),
  timestamp: z.string().optional(),
  includePayloadHash: z.boolean().default(false),
});

export const awsSigV4ConfigSchema: z.ZodType<AwsSigV4Config> = z.object({
  accessKey: z.string().default(""),
  secretKey: z.string().default(""),
  sessionToken: z.string().optional(),
  region: z.string().optional(),
  service: z.string().default(""),
  addTo: z.enum(["header", "query"]).optional(),
  expiresSeconds: z.number().int().min(1).max(604800).optional(),
  timestamp: z.string().optional(),
});

export const oauth1ConfigSchema: z.ZodType<OAuth1Config> = z.object({
  consumerKey: z.string().default(""),
  consumerSecret: z.string().default(""),
  token: z.string().optional(),
  tokenSecret: z.string().optional(),
  signatureMethod: z
    .enum(["HMAC-SHA1", "HMAC-SHA256", "HMAC-SHA512", "RSA-SHA1", "RSA-SHA256", "RSA-SHA512", "PLAINTEXT"])
    .optional(),
  privateKey: z
    .string()
    .max(64 * 1024)
    .optional(),
  addTo: z.enum(["header", "query", "body"]).optional(),
  timestamp: z.string().optional(),
  nonce: z.string().optional(),
  version: z.string().optional(),
  realm: z.string().optional(),
  callback: z.string().optional(),
  verifier: z.string().optional(),
  includeBodyHash: z.boolean().optional(),
  addEmptyParamsToSign: z.boolean().optional(),
});

export const asapConfigSchema: z.ZodType<AsapConfig> = z.object({
  algorithm: z
    .enum(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"])
    .optional(),
  issuer: z.string().default(""),
  subject: z.string().optional(),
  audience: z.string().default(""),
  keyId: z.string().default(""),
  privateKey: z
    .string()
    .max(64 * 1024)
    .default(""),
  expiry: z.string().optional(),
  additionalClaims: z
    .string()
    .max(16 * 1024)
    .optional(),
});

export const authSchema: z.ZodType<AuthConfig> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inherit") }),
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("bearer"),
    bearer: z.object({ token: z.string(), prefix: z.string().optional() }),
  }),
  z.object({ type: z.literal("basic"), basic: z.object({ username: z.string(), password: z.string() }) }),
  z.object({
    type: z.literal("apikey"),
    apikey: z.object({
      key: z.string(),
      value: z.string(),
      in: z.enum(["header", "query"]).default("header"),
    }),
  }),
  z.object({ type: z.literal("digest"), digest: z.object({ username: z.string(), password: z.string() }) }),
  z.object({ type: z.literal("oauth2"), oauth2: oauth2ConfigSchema }),
  z.object({ type: z.literal("edgegrid"), edgegrid: edgeGridConfigSchema }),
  z.object({ type: z.literal("hawk"), hawk: hawkConfigSchema }),
  z.object({ type: z.literal("awsv4"), awsv4: awsSigV4ConfigSchema }),
  z.object({ type: z.literal("oauth1"), oauth1: oauth1ConfigSchema }),
  z.object({ type: z.literal("asap"), asap: asapConfigSchema }),
  z.object({
    type: z.literal("ntlm"),
    ntlm: z.object({
      username: z.string().default(""),
      password: z.string().default(""),
      domain: z.string().optional(),
      workstation: z.string().optional(),
    }),
  }),
]);

export const settingsPatchSchema = z.object({
  followRedirects: z.boolean().optional(),
  maxRedirects: z.number().int().min(0).max(50).optional(),
  timeoutMs: z.number().int().min(100).max(300_000).optional(),
  verifySsl: z.boolean().optional(),
  useCookieJar: z.boolean().optional(),
  socketPath: z.string().max(1024).optional(),
  httpVersion: z.enum(["http1", "auto", "http2"]).optional(),
  grpc: z
    .object({
      protos: z.record(z.string().min(1).max(256), z.string().max(1_048_576)),
      reflection: z.boolean().optional(),
      definitionId: z.string().min(1).max(64).optional(),
      service: z.string().max(256),
      method: z.string().max(256),
    })
    .optional(),
  mqtt: z
    .object({
      clientId: z.string().max(256).optional(),
      protocolVersion: z.union([z.literal(4), z.literal(5)]).optional(),
      clean: z.boolean().optional(),
      keepalive: z.number().int().min(0).max(65535).optional(),
      subscriptions: z
        .array(
          z.object({
            topic: z.string().min(1).max(1024),
            qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
          }),
        )
        .max(100)
        .optional(),
    })
    .optional(),
  socketio: z
    .object({
      namespace: z.string().max(256).optional(),
      path: z.string().max(256).optional(),
      listeners: z.array(z.string().max(256)).max(100).optional(),
      ackTimeoutMs: z.number().int().min(100).max(120_000).optional(),
      auth: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

/** Variable rows as edited in the UI; rows with an empty key are dropped on save. */
export const variableSchema = z.object({
  key: z.string(),
  value: z.string().default(""),
  type: z.enum(["default", "secret"]).default("default"),
  enabled: z.boolean().default(true),
});

export const exampleRequestSchema = z.object({
  method: methodSchema,
  url: z.string(),
  params: z.array(keyValueSchema).default([]),
  headers: z.array(keyValueSchema).default([]),
  body: bodySchema,
  auth: authSchema.default({ type: "inherit" }),
  description: z.string().optional(),
});
export const responseExampleSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(300),
  status: z.number().int().min(100).max(599),
  statusText: z
    .string()
    .max(300)
    .refine((value) => !/[\r\n\0]/.test(value), "Invalid status text")
    .default(""),
  headers: z
    .array(
      keyValueSchema.extend({
        key: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "Invalid response header name"),
        value: z
          .string()
          .refine((value) => !/[\r\n\0]/.test(value), "Response header values cannot contain line breaks"),
      }),
    )
    .max(1000)
    .default([]),
  body: z.string().max(MAX_UPLOAD_BASE64_CHARS).default(""),
  createdAt: z.number().finite(),
  originalRequest: exampleRequestSchema.optional(),
  bodyEncoding: z.enum(["utf8", "base64"]).optional(),
  bodyOmitted: z.boolean().optional(),
  truncated: z.boolean().optional(),
});
export const exampleInputSchema = responseExampleSchema.omit({ id: true, createdAt: true });
export const exampleMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), example: exampleInputSchema }),
  z.object({
    action: z.literal("update"),
    exampleId: z.string().min(1),
    changes: exampleInputSchema.partial(),
  }),
  z.object({
    action: z.literal("duplicate"),
    exampleId: z.string().min(1),
    name: z.string().trim().min(1).max(300).optional(),
  }),
  z.object({ action: z.literal("delete"), exampleId: z.string().min(1) }),
  z.object({ action: z.literal("reorder"), exampleIds: z.array(z.string().min(1)).max(100) }),
]);
export const exampleCommandSchema = z.object({
  expectedVersion: z.string().optional(),
  mutation: exampleMutationSchema,
});

/** Any subset of a request definition (create, patch, ad-hoc execution). */
export const requestInputSchema = z
  .object({
    id: z.string(),
    name: z.string().max(300),
    method: methodSchema,
    url: z.string(),
    params: z.array(keyValueSchema),
    headers: z.array(keyValueSchema),
    body: bodySchema,
    auth: authSchema,
    preRequestScript: z.string(),
    testScript: z.string(),
    settings: settingsPatchSchema,
    description: z.string(),
    examples: z.array(responseExampleSchema),
    contract: contractSchema.nullable().superRefine((value, ctx) => {
      if (value)
        try {
          parseContract(value);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: error instanceof Error ? error.message : "Invalid contract",
          });
        }
    }),
  })
  .partial();

// ------------------------------------------------------------------ script sandbox messages

const sandboxHeaderSchema = z.object({
  key: z.coerce.string(),
  value: z.coerce.string().default(""),
  disabled: z
    .unknown()
    .optional()
    .transform((v) => (v === undefined ? undefined : Boolean(v))),
});

/** Body contents are normalized field by field by the executor; only the envelope is checked here. */
const sandboxBodySchema = z.record(z.string(), z.unknown());

/** Argument of pm.sendRequest as serialized by the bootstrap. */
export const sendRequestSpecSchema = z.object({
  url: z.string(),
  method: methodSchema,
  header: z.array(sandboxHeaderSchema).default([]),
  auth: authSchema.optional(),
  body: sandboxBodySchema.nullable().default(null),
});

const scopeValues = z.record(z.string(), z.string());

/** What __finalize() hands back. User code can replace it, so nothing is trusted. */
export const sandboxStateSchema = z.object({
  vaultSet: z.record(z.string(), z.string()).optional(),
  visualization: visualizationSchema.nullable().optional(),
  visualizationSet: z.boolean().optional(),
  scopes: z.object({
    globals: scopeValues,
    collection: scopeValues,
    environment: scopeValues,
    data: scopeValues,
    local: scopeValues,
  }),
  tests: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean(),
      error: z.string().optional(),
      skipped: z.boolean().optional(),
    }),
  ),
  nextRequest: z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string().nullish()),
  nextRequestSet: z.boolean(),
  skip: z.boolean(),
  request: z.object({
    url: z.string(),
    method: methodSchema,
    headers: z.array(sandboxHeaderSchema),
    body: sandboxBodySchema.nullish(),
    auth: authSchema.optional(),
  }),
});

export const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;

/** Short, readable summary of a ZodError for messages that cross a trust boundary. */
export function describeIssues(error: z.ZodError, max = 3): string {
  const parts = error.issues
    .slice(0, max)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
  if (error.issues.length > max) parts.push(`…and ${error.issues.length - max} more`);
  return parts.join("; ");
}
