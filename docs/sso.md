# User single sign-on

Administrators can configure OpenID Connect and SAML 2.0 in **Profile → Manage single sign-on** (`/admin/sso`). This signs users into Postbox; outbound request OAuth remains separate.

Create a local administrator with a password first, or configure `POSTBOX_TOKEN` as a recovery credential. Postbox refuses to enable SSO without one of these. Password login stays on `/login`. An environment password alone is insufficient once local accounts exist. Keep recovery credentials independent of the identity provider.

Create a disabled provider, enter its settings, save, register the displayed callback URL with the IdP, then enable it. The public origin is an explicit trusted configuration, never inferred from incoming Host/forwarding headers. Use the externally reachable HTTPS origin without a trailing slash. Loopback HTTP is accepted for OIDC development. SAML requires HTTPS because its cross-site POST callback needs a Secure, SameSite=None correlation cookie.

## OpenID Connect

Supply the exact issuer discovery URL, client ID, client authentication method (secret basic, secret post, or public client), and expected ID token signing algorithm. Register the exact callback URI as a web authorization-code callback. Postbox requests `openid profile email`, uses PKCE S256, state, and nonce, and explicitly verifies the ID token signature against the issuer's JWKS as well as issuer, audience, expiry and nonce. Unsigned and unexpected algorithms are rejected. Access and refresh tokens are not retained.

Discovery, token and JWKS calls honor Postbox's outbound host, proxy and TLS policy, with 15-second timeouts and 1 MiB responses. Redirects are refused. Ensure the IdP advertises directly reachable endpoints. Secrets are write-only and encrypted with the external vault keyring. Save with an omitted secret to keep the stored value; explicit values replace it.

## SAML 2.0

Supply the IdP sign-in URL, exact IdP issuer, pinned signing certificate in PEM, and Postbox's SP entity ID. The callback is the Assertion Consumer Service using HTTP POST. Register the SP metadata from the provider's metadata link. Configure the IdP to sign **both the response and assertion** and emit a stable persistent NameID. Only SP-initiated correlated logins are accepted. Optional SP private key plus public certificate signs outbound authentication requests using SHA-256.

Verification requires signatures, exact issuer and audience, assertion timestamps, request correlation and assertion replay protection. Postbox also enforces the signed bearer SubjectConfirmation recipient and InResponseTo against the exact callback and request. Logins expire after five minutes; accepted clock skew is ten seconds. Assertion replay protection spans browser login attempts for a provider. Configure trusted IdP signing certificates; incoming signature validation uses the SAML library's supported algorithms.

## Identity and workspace roles

The identity key is the provider ID plus the verified OIDC `sub` or SAML NameID. Email and local usernames never automatically link identities. With automatic provisioning disabled (the default), administrators map an exact subject to an existing account ID. With it enabled, a new subject creates a non-administrator account with its own private workspace and no usable local password. Disabled, deleted and service accounts cannot sign in. Provisioning never reactivates SCIM-disabled users.

Choose a display-name claim and groups claim. Each workspace mapping contains `workspaceId`, exact signed `group`, and `role` (`viewer`, `editor`, `owner`). The highest matching role wins per workspace. Only memberships created by that provider are reconciled on subsequent logins; unmatched managed roles are removed. Existing manual memberships and memberships managed by another provider take precedence. Global administrator status is never granted by claims. Removing groups takes effect at the next successful login; for immediate offboarding, disable the account via local administration or SCIM, which invalidates its sessions and tokens.

Changing provider configuration revokes linked account browser sessions, removes that provider's managed roles, and invalidates pending login attempts. It does not revoke personal API keys; their workspace access follows current memberships. Changing issuer or client/entity identity requires a new provider to prevent old subject mappings crossing trust boundaries. Certificate and client-secret rotation is supported on the existing provider. Disable a provider to withdraw login and its managed roles; delete a disabled provider to remove its mappings. Local accounts and private workspaces remain.

Sessions expire at the earliest of the configured provider lifetime (60–86,400 seconds), verified IdP token/assertion expiry and instance session limit. There is no silent refresh. **Sign out** clears the local session cookie; it does not log out of the IdP or implement IdP single logout. A subsequent sign-in may reuse an existing IdP session.

## Automation and recovery

Use a full-scope administrator API token or the environment recovery bearer token. All administrative writes use the existing origin and audit enforcement. Public login endpoints authenticate correlation and signatures themselves; the SAML POST callback is the sole origin-check exception in this flow.

- `GET /api/admin/sso`: configurations and `hasSecrets`, without stored secret values.
- `POST /api/admin/sso`: `{ "config": { ... }, "secrets": { "clientSecret": "..." } }` (or `privateKey` for SAML); returns `{ "id": "..." }`.
- `PUT /api/admin/sso/:id`: same body, replacing configuration and merging supplied secret fields. Preserve omitted credentials.
- `POST /api/admin/sso/:id/identities`: `{ "subject": "verified-stable-id", "userId": "existing-account-id" }`. Duplicate mappings fail rather than silently reassigning accounts.
- `DELETE /api/admin/sso/:id`: removes provider and identity mappings and revokes linked sessions/managed roles.
- `GET /api/auth/sso/:id/start?next=/profile`: starts browser login. Callback accepts GET for OIDC and POST for SAML.
- `GET /api/auth/sso/:id/metadata`: enabled SAML provider metadata.

Example OIDC configuration:

```json
{
  "config": {
    "kind": "oidc",
    "name": "Company sign-in",
    "enabled": false,
    "origin": "https://postbox.example.com",
    "issuer": "https://idp.example.com",
    "clientId": "postbox",
    "clientAuth": "basic",
    "algorithm": "RS256",
    "autoProvision": false,
    "sessionSeconds": 3600,
    "displayNameClaim": "name",
    "groupsClaim": "groups",
    "roles": []
  },
  "secrets": { "clientSecret": "replace-me" }
}
```

SSO configuration, identities and login state are instance authentication data, excluded from workspace JSON export/import. For disaster recovery retain the database and external vault key file separately and securely. Vault rotation re-encrypts SSO credentials and pending login state before pruning old keys. A restored database without its keys requires an administrator to re-enter provider secrets; users can still recover through local passwords or the configured recovery token. Invalid callbacks return a generic failure without echoing assertion, token or provider secrets; start a fresh login after correcting configuration.
