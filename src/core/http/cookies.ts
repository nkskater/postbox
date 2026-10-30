/**
 * Cookie jar backed by tough-cookie. The jar can be loaded from and dumped to
 * plain `CookieInfo` lists so it can be persisted in SQLite per workspace.
 */
import { Cookie, CookieJar, MemoryCookieStore } from "tough-cookie";
import type { CookieInfo } from "../types";

export type CookieKey = Pick<CookieInfo, "domain" | "path" | "name">;
export interface CookieChanges {
  upserts: CookieInfo[];
  deletions: CookieKey[];
}
const cookieKey = (c: CookieKey) => JSON.stringify([c.domain, c.path, c.name]);

export class CookieJarStore {
  private readonly changes = new Map<string, CookieInfo>();
  readonly jar: CookieJar;

  constructor(initial: CookieInfo[] = []) {
    this.jar = new CookieJar(new MemoryCookieStore(), { looseMode: true, rejectPublicSuffixes: false });
    for (const c of initial) this.add(c);
  }

  /** Add a cookie described by a CookieInfo without URL validation. */
  add(c: CookieInfo): void {
    const cookie = new Cookie({
      key: c.name,
      value: c.value,
      domain: c.domain.replace(/^\./, ""),
      path: c.path || "/",
      expires: c.expires != null ? new Date(c.expires) : "Infinity",
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite ?? undefined,
      hostOnly: c.hostOnly ?? true,
    });
    this.jar.store.putCookie(cookie).catch(() => undefined);
  }

  /** Value for the Cookie request header, or "" if none apply. */
  async getCookieHeader(url: string): Promise<string> {
    try {
      return await this.jar.getCookieString(url);
    } catch {
      return "";
    }
  }

  /** Store every Set-Cookie header of a response. Invalid cookies are ignored. */
  async storeSetCookies(setCookies: string[], url: string): Promise<CookieInfo[]> {
    const stored: CookieInfo[] = [];
    for (const header of setCookies) {
      try {
        const c = await this.jar.setCookie(header, url, { ignoreError: true });
        if (c) {
          const info = toInfo(c);
          stored.push(info);
          this.changes.set(cookieKey(info), info);
        }
      } catch {
        /* ignore malformed cookies */
      }
    }
    return stored;
  }

  async list(): Promise<CookieInfo[]> {
    const all = await this.jar.store.getAllCookies();
    const now = Date.now();
    return all.filter((c) => (c.expiryTime() ?? Infinity) > now).map(toInfo);
  }

  /** Only explicit writes/deletions are persisted; reads and expiry cleanup are not writes. */
  getChanges(): CookieChanges {
    const upserts: CookieInfo[] = [];
    const deletions: CookieKey[] = [];
    for (const c of this.changes.values()) {
      if (c.expires != null && c.expires <= Date.now())
        deletions.push({ domain: c.domain, path: c.path, name: c.name });
      else upserts.push({ ...c });
    }
    return { upserts, deletions };
  }

  async remove(domain: string, path: string, name: string): Promise<void> {
    domain = domain.replace(/^\./, "");
    path ||= "/";
    await this.jar.store.removeCookie(domain, path, name);
    const c: CookieInfo = {
      domain,
      path,
      name,
      value: "",
      expires: 0,
      httpOnly: false,
      secure: false,
      sameSite: null,
      hostOnly: true,
    };
    this.changes.set(cookieKey(c), c);
  }

  async clear(): Promise<void> {
    const all = await this.jar.store.getAllCookies();
    for (const c of all) await this.remove(c.domain ?? "", c.path ?? "/", c.key);
  }
}

export function toInfo(c: Cookie): CookieInfo {
  return {
    name: c.key,
    value: c.value,
    domain: c.domain ?? "",
    path: c.path ?? "/",
    expires: Number.isFinite(c.expiryTime()) ? c.expiryTime() : c.expiryTime() === -Infinity ? 0 : null,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite ?? null,
    hostOnly: c.hostOnly ?? true,
  };
}

/** Parse Set-Cookie headers of a single response into CookieInfo (no jar). */
export function parseSetCookies(setCookies: string[], url: string): CookieInfo[] {
  const host = new URL(url).hostname;
  const out: CookieInfo[] = [];
  for (const h of setCookies) {
    const c = Cookie.parse(h, { loose: true });
    if (!c) continue;
    const info = toInfo(c);
    if (!info.domain) info.domain = host;
    out.push(info);
  }
  return out;
}
