import { describe, expect, it } from "vitest";
import {
  VaultCryptoError,
  buildKeyring,
  decryptSecret,
  encodeKey,
  encryptSecret,
  generateKey,
  keyIdOf,
  keyIdOfCiphertext,
  parseKey,
  SECRET_NAME,
} from "@/core/vault/crypto";
import { VAULT_PREFIX, emptyScopes, lookupVariable, resolveTemplate } from "@/core/variables/resolver";

const ring = buildKeyring(generateKey());

describe("vault encryption", () => {
  it("round-trips values and never stores them in the clear", () => {
    const secret = "sk_live_α𝒳-very-secret";
    const { ciphertext, keyId } = encryptSecret(ring, "w1", "api", secret);
    expect(ciphertext).toMatch(/^v1\.[0-9a-f]{8}\.[\w-]+\.[\w-]+$/);
    expect(ciphertext).not.toContain(secret);
    expect(Buffer.from(ciphertext.split(".")[3], "base64url").toString("utf8")).not.toContain("secret");
    expect(keyId).toBe(ring.current.id);
    expect(keyIdOfCiphertext(ciphertext)).toBe(keyId);
    expect(decryptSecret(ring, "w1", "api", ciphertext)).toBe(secret);
  });

  it("uses a fresh nonce every time", () => {
    const a = encryptSecret(ring, "w", "n", "same").ciphertext;
    const b = encryptSecret(ring, "w", "n", "same").ciphertext;
    expect(a).not.toBe(b);
    expect(decryptSecret(ring, "w", "n", a)).toBe(decryptSecret(ring, "w", "n", b));
  });

  it("binds a value to its workspace and name", () => {
    const { ciphertext } = encryptSecret(ring, "w1", "api", "v");
    expect(() => decryptSecret(ring, "w2", "api", ciphertext)).toThrow(/integrity/);
    expect(() => decryptSecret(ring, "w1", "other", ciphertext)).toThrow(/integrity/);
  });

  it("detects tampering and malformed data", () => {
    const { ciphertext } = encryptSecret(ring, "w", "n", "value");
    const parts = ciphertext.split(".");
    const body = Buffer.from(parts[3], "base64url");
    body[0] ^= 1;
    const tampered = [...parts.slice(0, 3), body.toString("base64url")].join(".");
    expect(() => decryptSecret(ring, "w", "n", tampered)).toThrowError(
      expect.objectContaining({ code: "tampered" }),
    );
    expect(() => decryptSecret(ring, "w", "n", "plain text")).toThrowError(
      expect.objectContaining({ code: "malformed" }),
    );
    expect(() => decryptSecret(ring, "w", "n", `v1.${parts[1]}.${parts[2]}.AAAA`)).toThrow(VaultCryptoError);
    expect(keyIdOfCiphertext("nope")).toBeNull();
  });

  it("reads old values through previous keys and reports keys that are gone", () => {
    const oldKey = generateKey();
    const old = encryptSecret(buildKeyring(oldKey), "w", "n", "legacy").ciphertext;
    const rotated = buildKeyring(generateKey(), [oldKey]);
    expect(decryptSecret(rotated, "w", "n", old)).toBe("legacy");
    expect(rotated.all.size).toBe(2);
    expect(() => decryptSecret(buildKeyring(generateKey()), "w", "n", old)).toThrowError(
      expect.objectContaining({ code: "unknown-key" }),
    );
  });

  it("parses keys as hex, base64 or base64url and rejects bad lengths", () => {
    const key = generateKey();
    expect(parseKey(key.toString("hex")).equals(key)).toBe(true);
    expect(parseKey(key.toString("base64")).equals(key)).toBe(true);
    expect(parseKey(encodeKey(key)).equals(key)).toBe(true);
    expect(() => parseKey("too short")).toThrow(/32 bytes/);
    expect(keyIdOf(key)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("validates secret names", () => {
    for (const ok of ["api", "stripe.live-key_2", "A1"]) expect(SECRET_NAME.test(ok)).toBe(true);
    for (const bad of ["", "-x", "has space", "a/b", "x".repeat(65), "{{x}}", "vault:x"])
      expect(SECRET_NAME.test(bad)).toBe(false);
  });
});

describe("vault references in templates", () => {
  const scopes = {
    ...emptyScopes(),
    environment: { token: "env-token" },
    vault: { api: "sk_{{not-a-var}}_1", "db.pass": "p" },
  };

  it("resolves {{vault:name}} and leaves braces inside the secret alone", () => {
    expect(resolveTemplate("Bearer {{vault:api}}", scopes).value).toBe("Bearer sk_{{not-a-var}}_1");
    expect(resolveTemplate("{{ vault:db.pass }}", scopes).value).toBe("p");
    expect(lookupVariable(scopes, "vault:api")).toEqual({ value: "sk_{{not-a-var}}_1", scope: "vault" });
    expect(VAULT_PREFIX).toBe("vault:");
  });

  it("reports unknown vault secrets as unresolved and never reads them as ordinary variables", () => {
    const r = resolveTemplate("{{vault:missing}} {{token}}", scopes);
    expect(r.value).toBe("{{vault:missing}} env-token");
    expect(r.unresolved).toEqual(["vault:missing"]);
    // The prefix is reserved: an ordinary variable cannot stand in for (or shadow) a vault secret.
    expect(resolveTemplate("{{vault:x}}", { ...emptyScopes(), environment: { "vault:x": "no" } }).value).toBe(
      "{{vault:x}}",
    );
    expect(resolveTemplate("{{vault:api}}", emptyScopes()).unresolved).toEqual(["vault:api"]);
  });
});
