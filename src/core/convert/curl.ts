/**
 * cURL command parser → request definition.
 * Supports the options commonly produced by browsers' "Copy as cURL" (bash and Windows cmd)
 * and API docs. Anything it cannot carry over is reported in `warnings` rather than dropped.
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
  /** From --max-time / -m, when given. */
  timeoutMs?: number;
  /** What could not be imported as written: file bodies, uploads, ignored options, extra URLs. */
  warnings: string[];
}

/** True for commands copied from Windows cmd ("Copy as cURL (cmd)"), which escape with `^`. */
export function isCmdStyle(cmd: string): boolean {
  return /\^"|\^\r?\n|\^[ \t]*$/m.test(cmd);
}

/**
 * Splits a cmd.exe command line: `^` escapes the next character (and `^` + newline continues
 * the line), then arguments are split with the Windows C runtime rules (double quotes group,
 * `""` inside quotes and backslash-escaped quotes are literal quotes).
 */
export function tokenizeCmd(cmd: string): string[] {
  const s = cmd.replace(/\^\r?\n/g, " ").replace(/\^([\s\S])/g, "$1");
  const out: string[] = [];
  let cur = "";
  let inToken = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      let n = 0;
      while (s[i] === "\\") {
        n++;
        i++;
      }
      if (s[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2) cur += '"';
        else {
          quoted = !quoted;
        }
      } else {
        cur += "\\".repeat(n);
        i--;
      }
      inToken = true;
    } else if (c === '"') {
      inToken = true;
      if (quoted && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && /\s/.test(c)) {
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
  "--url-query",
  "--aws-sigv4",
  "--data-urlencode",
  "-r",
  "--range",
  "-z",
  "--time-cond",
  "-E",
  "--cert",
  "--cert-type",
  "--key",
  "--key-type",
  "--pass",
  "--cacert",
  "--capath",
  "--ciphers",
  "--resolve",
  "--connect-to",
  "--interface",
  "--local-port",
  "--limit-rate",
  "--max-filesize",
  "--max-redirs",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "--keepalive-time",
  "--expect100-timeout",
  "-K",
  "--config",
  "-D",
  "--dump-header",
  "--trace",
  "--trace-ascii",
  "--stderr",
  "-U",
  "--proxy-user",
  "--proxy-header",
  "--noproxy",
  "--preproxy",
  "--socks5",
  "--socks5-hostname",
  "--unix-socket",
  "--abstract-unix-socket",
  "--dns-servers",
  "--doh-url",
  "-Q",
  "--quote",
  "--mail-from",
  "--mail-rcpt",
  "--hostpubmd5",
  "--pinnedpubkey",
  "--request-target",
  "--sasl-authzid",
  "--service-name",
  "--tls-max",
  "--variable",
  "--expand-data",
  "--output-dir",
  "-C",
  "--continue-at",
  "-Y",
  "--speed-limit",
  "-y",
  "--speed-time",
  "--happy-eyeballs-timeout-ms",
]);

/** Options that take no value and do not change the imported request. */
const NO_EFFECT_FLAGS = new Set([
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-v",
  "--verbose",
  "-i",
  "--include",
  "-f",
  "--fail",
  "--fail-with-body",
  "--compressed",
  "--compressed-ssh",
  "-N",
  "--no-buffer",
  "-g",
  "--globoff",
  "--path-as-is",
  "--http1.0",
  "--http1.1",
  "--http2",
  "--http2-prior-knowledge",
  "--http3",
  "-4",
  "--ipv4",
  "-6",
  "--ipv6",
  "-#",
  "--progress-bar",
  "--no-progress-meter",
  "-O",
  "--remote-name",
  "-J",
  "--remote-header-name",
  "-n",
  "--netrc",
  "--raw",
  "--tr-encoding",
  "--no-keepalive",
  "--tcp-nodelay",
  "--tcp-fastopen",
  "--location-trusted",
  "--tlsv1",
  "--tlsv1.0",
  "--tlsv1.1",
  "--tlsv1.2",
  "--tlsv1.3",
  "--ssl",
  "--ssl-reqd",
  "--basic",
  "--anyauth",
  "--no-alpn",
  "--no-npn",
  "--no-sessionid",
  "--create-dirs",
  "--styled-output",
  "--no-styled-output",
]);

const looksLikeUrl = (s: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(s);

/** Expands `-sSL` into `-s -S -L` and `-XPOST` into `-X POST`. */
function expandShortFlags(tokens: string[]): string[] {
  const out: string[] = [];
  for (const tok of tokens) {
    if (!/^-[A-Za-z0-9#]{2,}/.test(tok) || tok.startsWith("--")) {
      out.push(tok);
      continue;
    }
    for (let j = 1; j < tok.length; j++) {
      const opt = `-${tok[j]}`;
      if (WITH_VALUE.has(opt)) {
        out.push(opt);
        if (j + 1 < tok.length) out.push(tok.slice(j + 1));
        break;
      }
      out.push(opt);
    }
  }
  return out;
}

/** `--aws-sigv4 provider1[:provider2[:region[:service]]]`, region and service falling back to the host. */
function awsSigV4(provider: string, url: string, creds: { username: string; password: string } | null) {
  const parts = provider.split(":");
  let [region, service] = [parts[2] ?? "", parts[3] ?? ""];
  const host = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url)?.[1] ?? "";
  const aws = /^(?:[^.]+\.)*?([a-z0-9-]+)\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com$/i.exec(host);
  if (aws) {
    service ||= aws[1];
    region ||= aws[2];
  }
  return {
    type: "awsv4" as const,
    awsv4: {
      accessKey: creds?.username ?? "",
      secretKey: creds?.password ?? "",
      service,
      ...(region ? { region } : {}),
    },
  };
}

export function parseCurl(command: string): ParsedCurl {
  const trimmed = command.trim();
  const tokens = expandShortFlags(isCmdStyle(trimmed) ? tokenizeCmd(trimmed) : tokenize(trimmed));
  if (!tokens.length || !/^curl(?:\.exe)?$/i.test(tokens[0]))
    throw new Error("Command must start with 'curl'");
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const extraUrls: string[] = [];
  const urlQuery: string[] = [];
  let bodyFile: string | null = null;
  let uploadFile: string | null = null;
  let timeoutMs: number | undefined;
  let awsProvider: string | null = null;

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
      case "--data-binary":
      case "--data-ascii":
      case "--json": {
        const d = next();
        if (tok === "--json") jsonBody = true;
        // curl reads the body from a file for @name (and from standard input for @-).
        if (d.startsWith("@")) {
          const file = d.slice(1);
          if (file === "-") warn("the body is read from standard input and was not imported");
          else {
            bodyFile ??= file;
            warn(`body comes from file ${file} (attach it)`);
          }
        } else data.push(d);
        break;
      }
      case "--data-raw":
        data.push(next());
        break;
      case "--data-urlencode": {
        const d = next();
        const at = /^([^=]*)@(.+)$/.exec(d);
        if (at && !d.includes("="))
          warn(`form value ${at[1] || "body"} comes from file ${at[2]} and was not imported`);
        else urlencoded.push(d);
        break;
      }
      case "-T":
      case "--upload-file":
        uploadFile = next();
        warn(`upload file ${uploadFile} was not imported (attach it)`);
        break;
      case "--url-query":
        urlQuery.push(next());
        break;
      case "-m":
      case "--max-time": {
        const seconds = Number(next());
        if (Number.isFinite(seconds) && seconds > 0) timeoutMs = Math.round(seconds * 1000);
        break;
      }
      case "--aws-sigv4":
        awsProvider = next();
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
        if (WITH_VALUE.has(tok)) {
          next();
          if (
            !["-o", "--output", "-w", "--write-out", "-c", "--cookie-jar", "--connect-timeout"].includes(tok)
          )
            warn(`ignored option ${tok}`);
        } else if (NO_EFFECT_FLAGS.has(tok)) {
          // Output and transport details that do not belong to the request.
        } else if (tok.startsWith("-") && tok.length > 1) {
          // An unknown option may take a value; never let that value become the URL.
          const following = tokens[i + 1];
          if (
            val === undefined &&
            following !== undefined &&
            !following.startsWith("-") &&
            !looksLikeUrl(following)
          )
            i++;
          warn(`ignored option ${tok}`);
        } else if (!url) url = tok;
        else extraUrls.push(tok);
    }
  }
  if (!url) throw new Error("No URL found in cURL command");
  if (extraUrls.length) warn(`only the first URL was imported (also given: ${extraUrls.join(", ")})`);
  if (digest && auth.type === "basic") auth = { type: "digest", digest: auth.basic };
  if (awsProvider !== null) {
    const creds = auth.type === "basic" ? auth.basic : null;
    auth = awsSigV4(awsProvider, /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`, creds);
    if (!auth.awsv4.service) warn("set the AWS service name in the Auth tab (not in --aws-sigv4)");
  }
  if (urlQuery.length) {
    const parts = urlQuery.map((q) => (q.startsWith("+") ? q.slice(1) : encodeUrlencodedArg(q)));
    url += (url.includes("?") ? "&" : "?") + parts.join("&");
  }

  const hasHeader = (n: string) => headers.some((h) => h.key.toLowerCase() === n);
  let body: BodyConfig = { mode: "none" };

  const contentType = headers.find((h) => h.key.toLowerCase() === "content-type")?.value;
  if (uploadFile !== null || bodyFile !== null) {
    if (data.length || urlencoded.length || form.length) warn("other body values were not imported");
    body = {
      mode: "binary",
      binary: {
        fileName: (uploadFile ?? bodyFile)!.split(/[\\/]/).pop() || (uploadFile ?? bodyFile)!,
        ...(contentType ? { contentType } : {}),
        data: "",
        missing: true,
      },
    };
  } else if (forceGet && (data.length || urlencoded.length)) {
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

  const finalMethod =
    method ?? (uploadFile !== null ? "PUT" : forceGet ? "GET" : body.mode !== "none" ? "POST" : "GET");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  return {
    method: finalMethod,
    url,
    headers,
    body,
    auth,
    insecure,
    followRedirects: follow,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    warnings,
  };
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
