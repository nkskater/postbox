/**
 * In-process caches for values read on every request (account count, session epoch, stored
 * secrets, saved settings, the resolved caller).
 *
 * Each cached value is stamped with the database's change marker: the number of rows this
 * connection has inserted, updated or deleted, plus SQLite's data version, which moves when
 * another connection commits. Any write anywhere (a new account, a disabled user, a revoked
 * key or session, a settings change, a backup restore, a command-line tool writing the same
 * file) changes the marker, so the next read misses and goes back to the database. There is no
 * list of writers to keep in sync.
 *
 * State lives on globalThis, per connection: the request gate and the route handlers can be
 * separate bundles, and tests open new databases.
 */
import type Database from "better-sqlite3";
import { getSqlite } from "./db";

interface Entry {
  stamp: string;
  value: unknown;
}

interface ConnectionCache {
  marker: Database.Statement<[], { t: number; v: number }>;
  values: Map<string, Entry>;
  statements: Map<string, unknown>;
}

const KEY = Symbol.for("postbox.dbCache");
const holder = globalThis as typeof globalThis & { [KEY]?: WeakMap<Database.Database, ConnectionCache> };

/** Cached entries kept per connection before the map is cleared (caller memos are keyed by credential). */
const MAX_ENTRIES = 500;

function connection(): ConnectionCache {
  const sqlite = getSqlite();
  const all = (holder[KEY] ??= new WeakMap());
  let cache = all.get(sqlite);
  if (!cache) {
    cache = {
      marker: sqlite.prepare(
        "select total_changes() as t, (select data_version from pragma_data_version) as v",
      ) as ConnectionCache["marker"],
      values: new Map(),
      statements: new Map(),
    };
    all.set(sqlite, cache);
  }
  return cache;
}

/** The current change marker; equal markers mean no row changed in between. */
export function changeStamp(): string {
  const { t, v } = connection().marker.get()!;
  return `${t}:${v}`;
}

/**
 * `compute()` once per database state (and while `isFresh`, when given, accepts the cached value). The stamp is taken after computing, so a value whose
 * computation wrote (a secret generated on first use) is stored against the state it left.
 */
export function cachedValue<T>(key: string, compute: () => T, isFresh?: (value: T) => boolean): T {
  const cache = connection();
  const hit = cache.values.get(key);
  if (hit && hit.stamp === changeStamp() && (!isFresh || isFresh(hit.value as T))) return hit.value as T;
  const value = compute();
  if (cache.values.size >= MAX_ENTRIES) cache.values.clear();
  cache.values.set(key, { stamp: changeStamp(), value });
  return value;
}

/** Forget every cached value (the next read of each goes to the database). */
export function clearCachedValues() {
  connection().values.clear();
}

/**
 * A statement prepared once per connection and reused. `build` must not depend on arguments:
 * pass values through placeholders.
 */
export function preparedOnce<T>(key: string, build: () => T): T {
  const cache = connection();
  if (!cache.statements.has(key)) cache.statements.set(key, build());
  return cache.statements.get(key) as T;
}
