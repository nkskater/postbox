import http from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
/** A local authorization server that signs real ID tokens and checks PKCE. */
export async function fakeOidc() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" };
  const codes = new Map<string, URLSearchParams>();
  let issuer = "";
  let overrides: Record<string, unknown> = {},
    badSignature = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/.well-known/openid-configuration")
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
    if (url.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/authorize") {
      const code = randomUUID();
      codes.set(code, url.searchParams);
      const target = new URL(url.searchParams.get("redirect_uri")!);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { Location: target.href });
      return res.end();
    }
    if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body),
        original = codes.get(params.get("code")!);
      codes.delete(params.get("code")!);
      if (
        !original ||
        original.get("code_challenge") !==
          createHash("sha256")
            .update(params.get("code_verifier") ?? "")
            .digest("base64url") ||
        original.get("redirect_uri") !== params.get("redirect_uri")
      ) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "invalid_grant" }));
      }
      const claims = {
        iss: issuer,
        sub: "subject-123",
        aud: original.get("client_id"),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: original.get("nonce"),
        name: "Federated Person",
        groups: ["developers"],
        ...overrides,
      };
      const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url"),
        payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      let signature = sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), privateKey);
      if (badSignature) {
        signature = Buffer.from(signature);
        signature[0] ^= 255;
      }
      return res.end(
        JSON.stringify({
          access_token: "unused-fixture-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: `${head}.${payload}.${signature.toString("base64url")}`,
        }),
      );
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    issuer,
    setClaims(value: Record<string, unknown>, invalidSignature = false) {
      overrides = value;
      badSignature = invalidSignature;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
