# Authentication

Postbox provides comprehensive request authentication covering industry-standard protocols, cloud provider request signing, and legacy enterprise schemes. Authentication can be configured on individual requests or inherited hierarchically across collections and folders.

---

## 1. Authentication Inheritance

Every request and folder in Postbox has an **Authorization** tab. By default, requests and subfolders have their auth type set to **Inherit auth from parent**.

```
Workspace
 └── Collection (e.g. Bearer Token)
      ├── Folder A (Inherit -> uses Collection's Bearer Token)
      │    └── Request 1 (Inherit -> uses Collection's Bearer Token)
      └── Folder B (Basic Auth -> overrides parent)
           ├── Request 2 (Inherit -> uses Folder B's Basic Auth)
           └── Request 3 (OAuth 2.0 -> overrides folder)
```

- **Inherit auth from parent (`type: "inherit"`)**: Postbox resolves the hierarchy from the request up through parent folders to the root collection, selecting the first explicit non-inherit configuration.
- **No Auth (`type: "none"`)**: Explicitly disables authentication for this request or folder, preventing parent auth from being applied.
- **Explicit Auth**: Applies the chosen authentication method directly to the request or folder.

---

## 2. Dynamic Variables & Vault Integration

All string fields in authentication configurations support `{{variable}}` substitution. Variables resolve across Postbox scopes according to standard precedence:

1. **Local variables** (set dynamically via scripts or iteration data)
2. **Iteration data** (CSV/JSON rows during collection runs)
3. **Environment variables**
4. **Collection variables**
5. **Global variables**

Sensitive fields (passwords, tokens, client secrets, private keys) are masked with bullets in the UI and automatically redacted from request history, logs, visualizers, and export bundles. You can also reference encrypted secrets stored in the Postbox Secrets Vault (`/api/vault`).

---

## 3. Supported Authentication Methods

### Bearer Token

Adds an `Authorization: Bearer <token>` header to the request.

- **Token**: The bearer token string or `{{variable}}`.
- **Prefix** _(optional)_: Defaults to `Bearer`. Custom prefix schemes (e.g. `JWT`, `SSWS`, `Token`) can be configured.

### Basic Auth

RFC 7617 HTTP Basic authentication.

- **Username**: The account username.
- **Password**: The account password (masked).
- Generates an `Authorization: Basic <base64(username:password)>` header.

### API Key

Injects an API key into either the request headers or query parameters.

- **Key**: Name of the header or query parameter (e.g. `X-API-Key`, `api_key`).
- **Value**: The API key value.
- **Add to**: Select **Header** or **Query Params**.

### AWS Signature Version 4 (SigV4)

Signs HTTP requests using AWS Signature Version 4 (`AWS4-HMAC-SHA256`).

- **AccessKey**: AWS Access Key ID.
- **SecretKey**: AWS Secret Access Key (masked).
- **SessionToken** _(optional)_: Temporary STS session token (adds `X-Amz-Security-Token`).
- **Region**: AWS region code (e.g. `us-east-1`, `eu-west-1`).
- **Service**: Target AWS service namespace (e.g. `s3`, `execute-api`, `sqs`, `dynamodb`).
- **Mode**:
  - **Authorization Header** (default): Adds `Authorization: AWS4-HMAC-SHA256 Credential=...` and `X-Amz-Date`.
  - **Presigned URL**: Injects authentication parameters (`X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-Signature`) into the query string.
- Automatically recalculates signatures if a request encounters a same-origin redirect.

### Akamai EdgeGrid

Implements Akamai EdgeGrid request signing (`EG1-HMAC-SHA256`).

- **Client Token**: Akamai `client_token`.
- **Client Secret**: Akamai `client_secret` (masked).
- **Access Token**: Akamai `access_token`.
- **Base URL** _(optional)_: Host base URL to validate request destination.
- **Headers to Sign** _(optional)_: Semicolon-delimited list of extra headers to include in the signature.
- **Max Body Size**: Enforces body hashing bounds (default 128 KiB).
- Derives timestamped signing keys and formats the `Authorization: EG1-HMAC-SHA256 ...` header.

### OAuth 2.0

Full-featured OAuth 2.0 client supporting automatic token retrieval, browser login, and background token refresh.

- **Grant Types**:
  - **Authorization Code**: Opens browser authorization flow with redirect URI handling.
  - **Authorization Code (with PKCE)**: Generates high-entropy `code_verifier` and SHA-256 `code_challenge`.
  - **Client Credentials**: Machine-to-machine authentication against token endpoints.
  - **Password**: Resource owner password credentials grant (`username` + `password`).
  - **Implicit**: Token extracted directly from fragment callback.
- **Configuration Options**:
  - `Auth URL`: Authorization endpoint URL for browser flows.
  - `Access Token URL`: Token exchange and refresh endpoint URL.
  - `Client ID` & `Client Secret`: OAuth application credentials.
  - `Scope`: Space-delimited requested scopes.
  - `Client Authentication`: Send client credentials in **Basic Auth Header** or **Request Body**.
- **Token Management**:
  - Acquired tokens are cached in-memory and re-used across collection runs.
  - Supports automatic token renewal via `refresh_token` upon expiry.
  - Clear cached tokens via UI or API (`POST /api/oauth2/tokens/clear`).

### OAuth 1.0a

RFC 5849 OAuth 1.0a request signing.

- **Consumer Key** & **Consumer Secret**: Application client credentials.
- **Token** & **Token Secret**: Authorized user token credentials.
- **Signature Method**: `HMAC-SHA1`, `HMAC-SHA256`, `RSA-SHA1` (with private key), or `PLAINTEXT`.
- **Add to**: **Header** (`Authorization: OAuth ...`), **Query Params**, or **Request Body** (`application/x-www-form-urlencoded`).
- Automatic generation of cryptographic `oauth_nonce` and `oauth_timestamp`.

### Digest Authentication

RFC 7616 / RFC 2617 HTTP Digest authentication.

- **Username** & **Password**: Credentials.
- Postbox handles the 401 Unauthorized challenge-response flow automatically:
  1. Issues initial probe request.
  2. Extracts `realm`, `nonce`, `qop`, `opaque`, and `algorithm` (MD5 or SHA-256) from `WWW-Authenticate`.
  3. Computes `HA1`, `HA2`, `response`, and client nonce `cnonce`.
  4. Resends authenticated request with `Authorization: Digest ...` header.

### Hawk Authentication

Hawk message authentication scheme with HMAC payload verification.

- **Auth ID**: Hawk credential ID.
- **Auth Key**: Hawk secret key.
- **Algorithm**: `sha256` or `sha1`.
- **Include Payload Hash**: Computes cryptographic hash of the request body.
- **User / Ext / App / Dlg**: Optional Hawk context fields.

### NTLMv2 Authentication

Microsoft Windows NT LAN Manager (NTLM) challenge-response authentication.

- **Username**, **Password**, **Domain**, and **Workstation**.
- Executes three-way handshake:
  1. Client sends Type 1 Negotiate message.
  2. Server responds with Type 2 Challenge containing server challenge nonce.
  3. Client calculates NTLMv2 response and issues Type 3 Authenticate message.

### Atlassian ASAP (Automated Service Authentication Protocol)

Asymmetric JWT authentication for microservice communication.

- **Issuer (`iss`)**: Service identifier generating the token.
- **Audience (`aud`)**: Target resource server identifier.
- **Key ID (`kid`)**: Identifier for the signing public key.
- **Private Key**: PEM-formatted RSA (RS256, PS256) or ECDSA (ES256) private key.
- **Expiry / Claims**: Configurable TTL (maximum 1 hour) and custom JSON claims.
- Signs the JWT and attaches `Authorization: Bearer <jwt>`.

---

## 4. Automation and MCP Integration

All authentication settings can be inspected, created, and automated through the REST API and the Postbox MCP server:

- **Create/Update Request Auth**:
  ```http
  POST /api/requests
  Content-Type: application/json

  {
    "workspaceId": "ws-default",
    "name": "S3 List Objects",
    "method": "GET",
    "url": "https://my-bucket.s3.amazonaws.com/?list-type=2",
    "auth": {
      "type": "awsv4",
      "awsv4": {
        "accessKey": "{{AWS_ACCESS_KEY}}",
        "secretKey": "{{AWS_SECRET_KEY}}",
        "region": "us-east-1",
        "service": "s3"
      }
    }
  }
  ```
- **MCP Server Tools**: MCP clients (such as Claude Code) can create requests, update authorization parameters, trigger test executions, and manage OAuth 2.0 tokens through the `/api/mcp` endpoint.
