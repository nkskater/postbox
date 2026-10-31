/**
 * NTLM (NTLMv2) HTTP authentication messages (MS-NLMP). The engine runs the
 * three-message handshake on a single keep-alive connection: NEGOTIATE ->
 * CHALLENGE (401) -> AUTHENTICATE.
 */
import { createHmac, randomBytes } from "node:crypto";

const SIGNATURE = Buffer.from("NTLMSSP\0", "latin1");
const NEGOTIATE_UNICODE = 0x00000001;
const REQUEST_TARGET = 0x00000004;
const NEGOTIATE_NTLM = 0x00000200;
const NEGOTIATE_ALWAYS_SIGN = 0x00008000;
const NEGOTIATE_EXTENDED_SESSIONSECURITY = 0x00080000;
const NEGOTIATE_TARGET_INFO = 0x00800000;
const NEGOTIATE_128 = 0x20000000;
const NEGOTIATE_56 = 0x80000000;
const NEGOTIATE_FLAGS =
  NEGOTIATE_UNICODE |
  REQUEST_TARGET |
  NEGOTIATE_NTLM |
  NEGOTIATE_ALWAYS_SIGN |
  NEGOTIATE_EXTENDED_SESSIONSECURITY |
  NEGOTIATE_TARGET_INFO |
  NEGOTIATE_128 |
  NEGOTIATE_56;

/** MD4 (RFC 1320). OpenSSL 3 no longer offers it by default, and NTLM needs it for the NT hash. */
export function md4(input: Buffer): Buffer {
  const len = input.length;
  const padded = Buffer.alloc(((len + 8) >> 6) * 64 + 64);
  input.copy(padded);
  padded[len] = 0x80;
  padded.writeUInt32LE((len * 8) >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(len / 0x20000000), padded.length - 4);
  let [a, b, c, d] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
  const G = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
  const H = (x: number, y: number, z: number) => x ^ y ^ z;
  for (let off = 0; off < padded.length; off += 64) {
    const X = Array.from({ length: 16 }, (_, i) => padded.readUInt32LE(off + i * 4));
    const [aa, bb, cc, dd] = [a, b, c, d];
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + F(b, c, d) + X[i]) | 0, 3);
      d = rotl((d + F(a, b, c) + X[i + 1]) | 0, 7);
      c = rotl((c + F(d, a, b) + X[i + 2]) | 0, 11);
      b = rotl((b + F(c, d, a) + X[i + 3]) | 0, 19);
    }
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + G(b, c, d) + X[i] + 0x5a827999) | 0, 3);
      d = rotl((d + G(a, b, c) + X[i + 4] + 0x5a827999) | 0, 5);
      c = rotl((c + G(d, a, b) + X[i + 8] + 0x5a827999) | 0, 9);
      b = rotl((b + G(c, d, a) + X[i + 12] + 0x5a827999) | 0, 13);
    }
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + H(b, c, d) + X[i] + 0x6ed9eba1) | 0, 3);
      d = rotl((d + H(a, b, c) + X[i + 8] + 0x6ed9eba1) | 0, 9);
      c = rotl((c + H(d, a, b) + X[i + 4] + 0x6ed9eba1) | 0, 11);
      b = rotl((b + H(c, d, a) + X[i + 12] + 0x6ed9eba1) | 0, 15);
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  [a, b, c, d].forEach((v, i) => out.writeInt32LE(v, i * 4));
  return out;
}

const utf16 = (s: string) => Buffer.from(s, "utf16le");
const hmacMd5 = (key: Buffer, ...data: Buffer[]) => {
  const h = createHmac("md5", key);
  for (const d of data) h.update(d);
  return h.digest();
};

/** NTOWFv2 (MS-NLMP 3.3.2). */
export function ntowfv2(password: string, user: string, domain: string): Buffer {
  return hmacMd5(md4(utf16(password)), utf16(user.toUpperCase() + domain));
}

/** Type 1 message, base64 for `Authorization: NTLM ...`. */
export function negotiateMessage(): string {
  const msg = Buffer.alloc(32);
  SIGNATURE.copy(msg);
  msg.writeUInt32LE(1, 8);
  msg.writeUInt32LE(NEGOTIATE_FLAGS >>> 0, 12);
  // Empty domain and workstation security buffers (offsets point past the header).
  msg.writeUInt32LE(32, 20);
  msg.writeUInt32LE(32, 28);
  return msg.toString("base64");
}

export interface NtlmChallenge {
  flags: number;
  serverChallenge: Buffer;
  targetInfo: Buffer;
}

/** Parse the Type 2 message from a `WWW-Authenticate: NTLM <base64>` header value. */
export function parseChallenge(header: string): NtlmChallenge | null {
  const m = /^\s*NTLM\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 32 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.readUInt32LE(8) !== 2) return null;
  const flags = buf.readUInt32LE(20);
  let targetInfo = Buffer.alloc(0);
  if (buf.length >= 48) {
    const len = buf.readUInt16LE(40);
    const off = buf.readUInt32LE(44);
    if (off + len <= buf.length) targetInfo = Buffer.from(buf.subarray(off, off + len));
  }
  return { flags, serverChallenge: Buffer.from(buf.subarray(24, 32)), targetInfo };
}

/** Windows FILETIME (100ns ticks since 1601-01-01) as 8 little-endian bytes. */
function filetime(ms: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE((BigInt(Math.floor(ms)) + BigInt(11644473600000)) * BigInt(10000));
  return out;
}

export interface NtlmV2Responses {
  ntChallengeResponse: Buffer;
  lmChallengeResponse: Buffer;
}

/** NTLMv2 and LMv2 responses (MS-NLMP 3.3.2). */
export function ntlmv2Responses(
  responseKey: Buffer,
  serverChallenge: Buffer,
  clientChallenge: Buffer,
  timestamp: Buffer,
  targetInfo: Buffer,
): NtlmV2Responses {
  const temp = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    timestamp,
    clientChallenge,
    Buffer.alloc(4),
    targetInfo,
    Buffer.alloc(4),
  ]);
  const ntProof = hmacMd5(responseKey, serverChallenge, temp);
  return {
    ntChallengeResponse: Buffer.concat([ntProof, temp]),
    lmChallengeResponse: Buffer.concat([
      hmacMd5(responseKey, serverChallenge, clientChallenge),
      clientChallenge,
    ]),
  };
}

export interface NtlmCredentials {
  username: string;
  password: string;
  domain?: string;
  workstation?: string;
}

/** Split DOMAIN\user or user@domain when no domain is given separately. */
export function splitUser(creds: NtlmCredentials): { user: string; domain: string } {
  if (creds.domain) return { user: creds.username, domain: creds.domain };
  const backslash = creds.username.indexOf("\\");
  if (backslash > 0)
    return { user: creds.username.slice(backslash + 1), domain: creds.username.slice(0, backslash) };
  return { user: creds.username, domain: "" };
}

/** Type 3 message, base64 for `Authorization: NTLM ...`. */
export function authenticateMessage(
  creds: NtlmCredentials,
  challenge: NtlmChallenge,
  opts: { now?: number; clientChallenge?: Buffer } = {},
): string {
  const { user, domain } = splitUser(creds);
  const key = ntowfv2(creds.password, user, domain);
  const { ntChallengeResponse, lmChallengeResponse } = ntlmv2Responses(
    key,
    challenge.serverChallenge,
    opts.clientChallenge ?? randomBytes(8),
    filetime(opts.now ?? Date.now()),
    challenge.targetInfo,
  );
  const fields = [
    lmChallengeResponse,
    ntChallengeResponse,
    utf16(domain),
    utf16(user),
    utf16(creds.workstation ?? ""),
  ];
  const header = Buffer.alloc(64);
  SIGNATURE.copy(header);
  header.writeUInt32LE(3, 8);
  let offset = 64;
  // Security buffers in message order: LM, NT, domain, user, workstation, then the (empty) session key.
  fields.forEach((field, i) => {
    header.writeUInt16LE(field.length, 12 + i * 8);
    header.writeUInt16LE(field.length, 14 + i * 8);
    header.writeUInt32LE(offset, 16 + i * 8);
    offset += field.length;
  });
  header.writeUInt32LE(offset, 56);
  const flags = (challenge.flags & NEGOTIATE_FLAGS) | NEGOTIATE_UNICODE | NEGOTIATE_NTLM;
  header.writeUInt32LE(flags >>> 0, 60);
  return Buffer.concat([header, ...fields]).toString("base64");
}
