/**
 * cURL command parser → request definition.
 * Supports the options commonly produced by browsers' "Copy as cURL" and API docs.
 */
import type { AuthConfig, BodyConfig, FormDataField, KeyValue } from "../types";

export interface ParsedCurl {
  method: string;
  url: string;
  headers: KeyValue[];
  body: BodyConfig;
  auth: AuthConfig;
  insecure: boolean;
  followRedirects: boolean;
}

/** POSIX-shell-like tokenizer handling single/double quotes, $'..', escapes and line continuations. */
export function tokenize(cmd: string): string[] {
  const s = cmd.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " "); // bash and cmd.exe continuations
  const out: string[] = [];
  let cur = "";
  let inToken = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      inToken = true;
      const end = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end;
    } else if (c === "$" && s[i + 1] === "'") {
      inToken = true;
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[++i];
          cur += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
        } else cur += s[i];
        i++;
      }
    } else if (c === '"') {
      inToken = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
        else cur += s[i];
        i++;
      }
    } else if (c === "\\" && i + 1 < s.length) {
      inToken = true;
      cur += s[++i];
    } else if (/\s/.test(c)) {
      if (inToken) out.push(cur);
      cur = "";
      inToken = false;
    } else {
      inToken = true;
      cur += c;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

const WITH_VALUE = new Set([
  "-X",
  "--request",
  "-H",
  "--header",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-ascii",
  "--data-urlencode",
  "-F",
  "--form",
  "--form-string",
  "-u",
  "--user",
  "-b",
  "--cookie",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "--url",
  "--json",
  "-o",
  "--output",
  "-m",
  "--max-time",
  "--connect-timeout",
  "-x",
  "--proxy",
  "--oauth2-bearer",
  "-w",
  "--write-out",
  "-c",
  "--cookie-jar",
  "-T",
  "--upload-file",
]);

export function parseCurl(command: string): ParsedCurl {
  const tokens = tokenize(command.trim());
  if (!tokens.length || tokens[0].toLowerCase() !== "curl") throw new Error("Command must start with 'curl'");

  let method: string | undefined;
  let url = "";
  const headers: KeyValue[] = [];
  const data: string[] = [];
  const urlencoded: string[] = [];
  const form: FormDataField[] = [];
  let auth: AuthConfig = { type: "inherit" };
  let forceGet = false;
  let insecure = false;
  let follow = false;
  let jsonBody = false;
  let digest = false;

  for (let i = 1; i < tokens.length; i++) {
    let tok = tokens[i];
    let val: string | undefined;
    // --opt=value form
    if (tok.startsWith("--") && tok.includes("=")) {
      const eq = tok.indexOf("=");
      val = tok.slice(eq + 1);
      tok = tok.slice(0, eq);
    } else if (/^-[A-Za-z]./.test(tok) && WITH_VALUE.has(tok.slice(0, 2))) {
      // -XPOST / -H'..' short form with attached value
      val = tok.slice(2);
      tok = tok.slice(0, 2);
    }
    const next = () => (val !== undefined ? val : (tokens[++i] ?? ""));

    switch (tok) {
      case "-X":
      case "--request":
        method = next().toUpperCase();
        break;
      case "-H":
      case "--header": {
        const h = next();
        const idx = h.indexOf(":");
        if (idx > 0)
          headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim(), enabled: true });
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        data.push(next());
        break;
      case "--json":
        data.push(next());
        jsonBody = true;
        break;
      case "--data-urlencode":
        urlencoded.push(next());
        break;
      case "-F":
      case "--form":
      case "--form-string": {
        const f = next();
        const idx = f.indexOf("=");
        const key = f.slice(0, idx);
        const value = f.slice(idx + 1);
        if (value.startsWith("@") && tok !== "--form-string") {
          form.push({ key, value: "", enabled: true, type: "file", fileName: value.slice(1).split(";")[0] });
        } else form.push({ key, value: value.replace(/^"|"$/g, ""), enabled: true, type: "text" });
        break;
      }
      case "-u":
      case "--user": {
        const u = next();
        const idx = u.indexOf(":");
        const creds = {
          username: idx >= 0 ? u.slice(0, idx) : u,
          password: idx >= 0 ? u.slice(idx + 1) : "",
        };
        auth = { type: "basic", basic: creds };
        break;
      }
      case "--digest":
        digest = true;
        break;
      case "--oauth2-bearer":
        auth = { type: "bearer", bearer: { token: next() } };
        break;
      case "-b":
      case "--cookie":
        headers.push({ key: "Cookie", value: next(), enabled: true });
        break;
      case "-A":
      case "--user-agent":
        headers.push({ key: "User-Agent", value: next(), enabled: true });
        break;
      case "-e":
      case "--referer":
        headers.push({ key: "Referer", value: next(), enabled: true });
        break;
      case "--url":
        url = next();
        break;
      case "-G":
      case "--get":
        forceGet = true;
        break;
      case "-I":
      case "--head":
        method = "HEAD";
        break;
      case "-k":
      case "--insecure":
        insecure = true;
        break;
      case "-L":
      case "--location":
        follow = true;
        break;
      default:
        if (WITH_VALUE.has(tok)) next();
        else if (!tok.startsWith("-") && !url) url = tok;
    }
  }
  if (!url) throw new Error("No URL found in cURL command");
  if (digest && auth.type === "basic") auth = { type: "digest", digest: auth.basic };

  const hasHeader = (n: string) => headers.some((h) => h.key.toLowerCase() === n);
  let body: BodyConfig = { mode: "none" };

  if (forceGet && (data.length || urlencoded.length)) {
    const qs = [...data, ...urlencoded.map(encodeUrlencodedArg)].join("&");
    url += (url.includes("?") ? "&" : "?") + qs;
  } else if (form.length) {
    body = { mode: "formdata", formdata: form };
    // Content-Type with boundary is generated when sending.
    const i = headers.findIndex(
      (h) => h.key.toLowerCase() === "content-type" && h.value.startsWith("multipart/"),
    );
    if (i >= 0) headers.splice(i, 1);
  } else if (urlencoded.length && !data.length) {
    body = {
      mode: "urlencoded",
      urlencoded: urlencoded.map((p) => {
        const idx = p.indexOf("=");
        return {
          key: idx >= 0 ? p.slice(0, idx) : p,
          value: idx >= 0 ? p.slice(idx + 1) : "",
          enabled: true,
        };
      }),
    };
  } else if (data.length || urlencoded.length) {
    const raw = [...data, ...urlencoded.map(encodeUrlencodedArg)].join("&");
    const ct = headers.find((h) => h.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
    if (jsonBody || ct.includes("json") || (!ct && /^\s*[[{]/.test(raw))) {
      body = { mode: "raw", raw: prettyJson(raw), language: "json" };
      if (!hasHeader("content-type"))
        headers.push({ key: "Content-Type", value: "application/json", enabled: true });
    } else if (ct.includes("xml")) body = { mode: "raw", raw, language: "xml" };
    else if (!ct || ct.includes("x-www-form-urlencoded")) {
      body = {
        mode: "urlencoded",
        urlencoded: raw
          .split("&")
          .filter(Boolean)
          .map((p) => {
            const idx = p.indexOf("=");
            const dec = (s: string) => {
              try {
                return decodeURIComponent(s.replace(/\+/g, " "));
              } catch {
                return s;
              }
            };
            return {
              key: dec(idx >= 0 ? p.slice(0, idx) : p),
              value: dec(idx >= 0 ? p.slice(idx + 1) : ""),
              enabled: true,
            };
          }),
      };
      const i = headers.findIndex((h) => h.key.toLowerCase() === "content-type");
      if (i >= 0) headers.splice(i, 1);
    } else body = { mode: "raw", raw, language: "text" };
  }

  const finalMethod = method ?? (forceGet ? "GET" : body.mode !== "none" ? "POST" : "GET");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  return { method: finalMethod, url, headers, body, auth, insecure, followRedirects: follow };
}

function encodeUrlencodedArg(p: string): string {
  const idx = p.indexOf("=");
  if (idx < 0) return encodeURIComponent(p);
  return `${p.slice(0, idx)}=${encodeURIComponent(p.slice(idx + 1))}`;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
