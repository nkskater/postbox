/**
 * JavaScript evaluated inside the QuickJS sandbox before every user script.
 *
 * It builds the Postman-compatible `pm` object on top of a JSON snapshot of the
 * execution context (`__ctx`) and a handful of host functions:
 *   __host_log(level, message)        console output
 *   __host_send(jsonRequest)          -> Promise<jsonResponse>   (pm.sendRequest)
 *   __host_sleep(ms)                  -> Promise<void>           (setTimeout)
 *   __host_dynamic(name)              -> string | undefined      ({{$guid}} etc.)
 *
 * When the script finishes the host calls `__finalize()` which returns the mutated
 * state as a JSON string. Only JSON crosses the boundary.
 *
 * NOTE: kept as a plain string (no template literals inside) so no bundler
 * transforms its contents.
 */
export const BOOTSTRAP_SOURCE = String.raw`
"use strict";
var __ctx = JSON.parse(__ctx_json);
var __state = { tests: [], nextRequest: undefined, nextRequestSet: false, skip: false, pending: [] };

// ---------------------------------------------------------------- utilities
function __isObj(v) { return v !== null && typeof v === "object"; }
function __type(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Date) return "date";
  if (v instanceof RegExp) return "regexp";
  if (typeof v === "number" && isNaN(v)) return "nan";
  return typeof v;
}
function __inspect(v, depth) {
  depth = depth || 0;
  if (typeof v === "string") return depth ? JSON.stringify(v) : v;
  if (typeof v === "function") return "[Function" + (v.name ? ": " + v.name : "") + "]";
  if (v === undefined) return "undefined";
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  if (v instanceof Error) return v.name + ": " + v.message;
  if (v instanceof RegExp) return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    var seen = [];
    return JSON.stringify(v, function (k, val) {
      if (__isObj(val)) { if (seen.indexOf(val) >= 0) return "[Circular]"; seen.push(val); }
      if (val === undefined) return "undefined";
      if (typeof val === "function") return "[Function]";
      return val;
    }, depth ? undefined : 2);
  } catch (e) { return String(v); }
}
function __short(v) { var s = __inspect(v, 1); return s && s.length > 200 ? s.slice(0, 200) + "…" : s; }
function __deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number" && isNaN(a) && isNaN(b)) return true;
  if (!__isObj(a) || !__isObj(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (var i = 0; i < ka.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !__deepEqual(a[ka[i]], b[ka[i]])) return false;
  }
  return true;
}
function __getPath(obj, path) {
  var parts = String(path).replace(/\[(\w+)\]/g, ".$1").split(".").filter(function (p) { return p !== ""; });
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (!__isObj(cur) || !(parts[i] in cur)) return { exists: false };
    cur = cur[parts[i]];
  }
  return { exists: true, value: cur };
}

// ---------------------------------------------------------------- console
function __fmt(args) { return Array.prototype.map.call(args, function (a) { return __inspect(a); }).join(" "); }
var console = {
  log: function () { __host_log("log", __fmt(arguments)); },
  info: function () { __host_log("info", __fmt(arguments)); },
  warn: function () { __host_log("warn", __fmt(arguments)); },
  error: function () { __host_log("error", __fmt(arguments)); },
  debug: function () { __host_log("debug", __fmt(arguments)); },
  clear: function () {}
};
globalThis.console = console;

// ---------------------------------------------------------------- timers / misc globals
globalThis.setTimeout = function (fn, ms) {
  var args = Array.prototype.slice.call(arguments, 2);
  var p = __host_sleep(Number(ms) || 0).then(function () { fn.apply(null, args); });
  __state.pending.push(p);
  return __state.pending.length;
};
globalThis.clearTimeout = function () {};
globalThis.setInterval = function () { throw new Error("setInterval is not supported in Postbox scripts"); };
var __B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
globalThis.btoa = function (input) {
  var str = String(input), out = "";
  for (var i = 0; i < str.length; i += 3) {
    var a = str.charCodeAt(i), b = str.charCodeAt(i + 1), c = str.charCodeAt(i + 2);
    var n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += __B64[(n >> 18) & 63] + __B64[(n >> 12) & 63] + (isNaN(b) ? "=" : __B64[(n >> 6) & 63]) + (isNaN(c) ? "=" : __B64[n & 63]);
  }
  return out;
};
globalThis.atob = function (input) {
  var str = String(input).replace(/[^A-Za-z0-9+/]/g, ""), out = "";
  for (var i = 0; i < str.length; i += 4) {
    var n = (__B64.indexOf(str[i]) << 18) | (__B64.indexOf(str[i + 1]) << 12) | ((__B64.indexOf(str[i + 2]) & 63) << 6) | (__B64.indexOf(str[i + 3]) & 63);
    out += String.fromCharCode((n >> 16) & 255);
    if (str[i + 2] !== undefined) out += String.fromCharCode((n >> 8) & 255);
    if (str[i + 3] !== undefined) out += String.fromCharCode(n & 255);
  }
  return out;
};
globalThis.require = function (name) {
  if (name === "chai") return { expect: __expect, assert: function (v, m) { if (!v) throw new AssertionError(m || "assertion failed"); } };
  throw new Error("Module '" + name + "' is not available in the Postbox sandbox");
};

// ---------------------------------------------------------------- expect (chai-style BDD subset)
function AssertionError(message) { this.name = "AssertionError"; this.message = message; }
AssertionError.prototype = Object.create(Error.prototype);
AssertionError.prototype.constructor = AssertionError;

function Assertion(obj, message) { this.__obj = obj; this.__flags = { message: message }; }
var __chainWords = ["to", "be", "been", "is", "that", "which", "and", "has", "have", "with", "at", "of", "same", "but", "does", "still", "also"];
__chainWords.forEach(function (w) {
  Object.defineProperty(Assertion.prototype, w, { get: function () { return this; } });
});
["not", "deep", "nested", "own", "any", "all", "ordered"].forEach(function (f) {
  Object.defineProperty(Assertion.prototype, f, { get: function () { this.__flags[f] = true; return this; } });
});
Assertion.prototype.__assert = function (cond, msg, negMsg) {
  var ok = this.__flags.not ? !cond : !!cond;
  if (!ok) {
    var m = this.__flags.not ? negMsg : msg;
    throw new AssertionError((this.__flags.message ? this.__flags.message + ": " : "") + m);
  }
  return this;
};
function __prop(name, fn) { Object.defineProperty(Assertion.prototype, name, { get: function () { fn.call(this); return this; } }); }
function __method(names, fn) { [].concat(names).forEach(function (n) { Assertion.prototype[n] = fn; }); }
// A "chainable method" works both as property (expect(x).to.include.members) and as call (expect(x).to.include(y)).
function __chainable(names, method, chainFlag) {
  [].concat(names).forEach(function (n) {
    Object.defineProperty(Assertion.prototype, n, {
      get: function () {
        var self = this;
        if (chainFlag) self.__flags[chainFlag] = true;
        var fn = function () { return method.apply(self, arguments); };
        Object.setPrototypeOf(fn, self);
        return fn;
      }
    });
  });
}
var __o = function (a) { return a.__obj; };

__prop("ok", function () {
  var v = __o(this);
  // Postman semantics: pm.response.to.be.ok means "status code is 200".
  if (v && v.__isResponse) return this.__assert(v.code === 200, "expected response code to be 200 but got " + v.code, "expected response code not to be 200");
  this.__assert(v, "expected " + __short(v) + " to be truthy", "expected " + __short(v) + " to be falsy");
});
__prop("true", function () { this.__assert(__o(this) === true, "expected " + __short(__o(this)) + " to be true", "expected value not to be true"); });
__prop("false", function () { this.__assert(__o(this) === false, "expected " + __short(__o(this)) + " to be false", "expected value not to be false"); });
__prop("null", function () { this.__assert(__o(this) === null, "expected " + __short(__o(this)) + " to be null", "expected value not to be null"); });
__prop("undefined", function () { this.__assert(__o(this) === undefined, "expected " + __short(__o(this)) + " to be undefined", "expected value not to be undefined"); });
__prop("NaN", function () { this.__assert(typeof __o(this) === "number" && isNaN(__o(this)), "expected " + __short(__o(this)) + " to be NaN", "expected value not to be NaN"); });
__prop("exist", function () { var v = __o(this); this.__assert(v !== null && v !== undefined, "expected " + __short(v) + " to exist", "expected " + __short(v) + " to not exist"); });
__prop("exists", function () { var v = __o(this); this.__assert(v !== null && v !== undefined, "expected " + __short(v) + " to exist", "expected " + __short(v) + " to not exist"); });
__prop("empty", function () {
  var v = __o(this), empty;
  if (typeof v === "string" || Array.isArray(v)) empty = v.length === 0;
  else if (__isObj(v)) empty = Object.keys(v).length === 0;
  else throw new AssertionError(".empty was passed non-string primitive " + __short(v));
  this.__assert(empty, "expected " + __short(v) + " to be empty", "expected " + __short(v) + " not to be empty");
});
__prop("success", function () { var c = __respCode(__o(this)); this.__assert(c >= 200 && c < 300, "expected response code to be 2XX but got " + c, "expected response code not to be 2XX"); });
__prop("info", function () { var c = __respCode(__o(this)); this.__assert(c >= 100 && c < 200, "expected response code to be 1XX but got " + c, "expected response code not to be 1XX"); });
__prop("redirection", function () { var c = __respCode(__o(this)); this.__assert(c >= 300 && c < 400, "expected response code to be 3XX but got " + c, "expected response code not to be 3XX"); });
__prop("clientError", function () { var c = __respCode(__o(this)); this.__assert(c >= 400 && c < 500, "expected response code to be 4XX but got " + c, "expected response code not to be 4XX"); });
__prop("serverError", function () { var c = __respCode(__o(this)); this.__assert(c >= 500, "expected response code to be 5XX but got " + c, "expected response code not to be 5XX"); });
__prop("error", function () { var c = __respCode(__o(this)); this.__assert(c >= 400, "expected response code to be 4XX or 5XX but got " + c, "expected response code not to be an error"); });
__prop("json", function () {
  var r = __o(this), ok = false;
  try { r.json(); ok = true; } catch (e) {}
  this.__assert(ok, "expected response body to be valid JSON", "expected response body not to be JSON");
});
function __respCode(r) { return r && typeof r.code === "number" ? r.code : NaN; }

function __equal(v) {
  var a = __o(this);
  if (this.__flags.deep) return this.__assert(__deepEqual(a, v), "expected " + __short(a) + " to deeply equal " + __short(v), "expected " + __short(a) + " to not deeply equal " + __short(v));
  return this.__assert(a === v, "expected " + __short(a) + " to equal " + __short(v), "expected " + __short(a) + " to not equal " + __short(v));
}
__method(["equal", "equals", "eq"], __equal);
__method(["eql", "eqls"], function (v) { var a = __o(this); return this.__assert(__deepEqual(a, v), "expected " + __short(a) + " to deeply equal " + __short(v), "expected " + __short(a) + " to not deeply equal " + __short(v)); });
function __num(self) { var v = self.__flags.length ? __lengthOf(self.__obj) : self.__obj; return v; }
function __lengthOf(v) { return v && typeof v.length === "number" ? v.length : (v && typeof v.size === "number" ? v.size : NaN); }
__method(["above", "gt", "greaterThan"], function (n) { var v = __num(this); return this.__assert(v > n, "expected " + __short(v) + " to be above " + n, "expected " + __short(v) + " to be at most " + n); });
__method(["least", "gte", "greaterThanOrEqual"], function (n) { var v = __num(this); return this.__assert(v >= n, "expected " + __short(v) + " to be at least " + n, "expected " + __short(v) + " to be below " + n); });
__method(["below", "lt", "lessThan"], function (n) { var v = __num(this); return this.__assert(v < n, "expected " + __short(v) + " to be below " + n, "expected " + __short(v) + " to be at least " + n); });
__method(["most", "lte", "lessThanOrEqual"], function (n) { var v = __num(this); return this.__assert(v <= n, "expected " + __short(v) + " to be at most " + n, "expected " + __short(v) + " to be above " + n); });
__method("within", function (a, b) { var v = __num(this); return this.__assert(v >= a && v <= b, "expected " + __short(v) + " to be within " + a + ".." + b, "expected " + __short(v) + " to not be within " + a + ".." + b); });
__method(["closeTo", "approximately"], function (n, delta) { var v = __o(this); return this.__assert(Math.abs(v - n) <= delta, "expected " + __short(v) + " to be close to " + n + " +/- " + delta, "expected " + __short(v) + " not to be close to " + n + " +/- " + delta); });
__chainable(["a", "an"], function (type) {
  var t = String(type).toLowerCase(), v = __o(this), actual = __type(v);
  var ok = actual === t || (t === "object" && actual === "object") || (t === "number" && actual === "nan");
  return this.__assert(ok, "expected " + __short(v) + " to be " + (/^[aeiou]/.test(t) ? "an " : "a ") + t, "expected " + __short(v) + " not to be " + (/^[aeiou]/.test(t) ? "an " : "a ") + t);
});
__method(["instanceOf", "instanceof"], function (C) { var v = __o(this); return this.__assert(v instanceof C, "expected " + __short(v) + " to be an instance of " + (C && C.name), "expected " + __short(v) + " not to be an instance of " + (C && C.name)); });
function __includes(hay, needle, deep) {
  if (typeof hay === "string") return hay.indexOf(String(needle)) !== -1;
  if (Array.isArray(hay)) return hay.some(function (x) { return deep ? __deepEqual(x, needle) : x === needle; });
  if (__isObj(hay) && __isObj(needle)) return Object.keys(needle).every(function (k) { return deep ? __deepEqual(hay[k], needle[k]) : hay[k] === needle[k]; });
  return false;
}
__chainable(["include", "includes", "contain", "contains"], function (needle) {
  var v = __o(this);
  return this.__assert(__includes(v, needle, this.__flags.deep), "expected " + __short(v) + " to include " + __short(needle), "expected " + __short(v) + " to not include " + __short(needle));
}, "contains");
__method("string", function (s) { var v = __o(this); return this.__assert(typeof v === "string" && v.indexOf(s) !== -1, "expected " + __short(v) + " to contain " + __short(s), "expected " + __short(v) + " to not contain " + __short(s)); });
__method(["match", "matches"], function (re) { var v = __o(this); return this.__assert(re.test(v), "expected " + __short(v) + " to match " + re, "expected " + __short(v) + " not to match " + re); });
__method("oneOf", function (list) { var v = __o(this); return this.__assert(list.some(function (x) { return __deepEqual(x, v); }), "expected " + __short(v) + " to be one of " + __short(list), "expected " + __short(v) + " to not be one of " + __short(list)); });
__method("members", function (list) {
  var v = __o(this), deep = this.__flags.deep;
  var has = function (arr, x) { return arr.some(function (y) { return deep ? __deepEqual(x, y) : x === y; }); };
  var ok = Array.isArray(v) && list.every(function (x) { return has(v, x); }) && (this.__flags.contains || v.length === list.length);
  return this.__assert(ok, "expected " + __short(v) + " to have the same members as " + __short(list), "expected " + __short(v) + " to not have the same members as " + __short(list));
});
__method(["keys", "key"], function () {
  var v = __o(this), keys = Array.prototype.slice.call(arguments);
  if (keys.length === 1 && Array.isArray(keys[0])) keys = keys[0];
  if (keys.length === 1 && __isObj(keys[0])) keys = Object.keys(keys[0]);
  var actual = __isObj(v) ? Object.keys(v) : [];
  var ok;
  if (this.__flags.any) ok = keys.some(function (k) { return actual.indexOf(k) !== -1; });
  else {
    ok = keys.every(function (k) { return actual.indexOf(k) !== -1; });
    if (!this.__flags.contains) ok = ok && actual.length === keys.length;
  }
  return this.__assert(ok, "expected " + __short(v) + " to have keys " + __short(keys), "expected " + __short(v) + " to not have keys " + __short(keys));
});
__method("property", function (name, val) {
  var v = __o(this), found;
  if (this.__flags.nested) found = __getPath(v, name);
  else found = { exists: v !== null && v !== undefined && (this.__flags.own ? Object.prototype.hasOwnProperty.call(v, name) : name in Object(v)), value: v === null || v === undefined ? undefined : v[name] };
  if (arguments.length < 2) {
    this.__assert(found.exists, "expected " + __short(v) + " to have property " + __short(name), "expected " + __short(v) + " to not have property " + __short(name));
  } else {
    var eq = this.__flags.deep ? __deepEqual(found.value, val) : found.value === val;
    this.__assert(found.exists && eq, "expected " + __short(v) + " to have property " + __short(name) + " of " + __short(val) + (found.exists ? ", but got " + __short(found.value) : ""), "expected " + __short(v) + " to not have property " + __short(name) + " of " + __short(val));
  }
  if (found.exists && !this.__flags.not) this.__obj = found.value;
  return this;
});
__method("ownProperty", function (name) { this.__flags.own = true; return this.property.apply(this, arguments); });
__chainable(["length", "lengthOf"], function (n) {
  var v = __o(this), len = __lengthOf(v);
  return this.__assert(len === n, "expected " + __short(v) + " to have a length of " + n + " but got " + len, "expected " + __short(v) + " to not have a length of " + n);
}, "length");
__method("satisfy", function (fn) { var v = __o(this); return this.__assert(fn(v), "expected " + __short(v) + " to satisfy " + __short(fn), "expected " + __short(v) + " to not satisfy " + __short(fn)); });
__method(["throw", "throws", "Throw"], function (expected) {
  var fn = __o(this), threw = false, err;
  try { fn(); } catch (e) { threw = true; err = e; }
  var ok = threw;
  if (threw && expected !== undefined) {
    var msg = err && err.message !== undefined ? err.message : String(err);
    if (expected instanceof RegExp) ok = expected.test(msg);
    else if (typeof expected === "string") ok = msg.indexOf(expected) !== -1;
    else if (typeof expected === "function") ok = err instanceof expected;
  }
  return this.__assert(ok, "expected function to throw" + (expected !== undefined ? " " + __short(expected) : ""), "expected function not to throw");
});
// Response-specific assertions (pm.response.to.have.status(200), pm.expect(pm.response).to.have.header("x")).
__method("status", function (s) {
  var r = __o(this);
  if (typeof s === "number") return this.__assert(r.code === s, "expected response to have status code " + s + " but got " + r.code, "expected response to not have status code " + s);
  return this.__assert(r.status === s, "expected response to have status reason '" + s + "' but got '" + r.status + "'", "expected response to not have status reason '" + s + "'");
});
__method("header", function (name, value) {
  var r = __o(this), headers = r.headers;
  var has = headers && headers.has(name);
  if (arguments.length < 2) return this.__assert(has, "expected response to have header " + name, "expected response to not have header " + name);
  var actual = has ? headers.get(name) : undefined;
  return this.__assert(has && actual === value, "expected response to have header " + name + " with value " + __short(value) + (has ? " but got " + __short(actual) : ""), "expected response to not have header " + name + " with value " + __short(value));
});
__method("body", function (expected) {
  var r = __o(this), text = r.text();
  if (arguments.length === 0) return this.__assert(text.length > 0, "expected response to have content in body", "expected response to not have content in body");
  if (expected instanceof RegExp) return this.__assert(expected.test(text), "expected response body to match " + expected, "expected response body to not match " + expected);
  if (typeof expected === "string") return this.__assert(text === expected, "expected response body to equal " + __short(expected), "expected response body to not equal " + __short(expected));
  var json; try { json = r.json(); } catch (e) {}
  return this.__assert(__deepEqual(json, expected), "expected response body to deeply equal " + __short(expected), "expected response body to not deeply equal " + __short(expected));
});
__method("jsonBody", function (path, value) {
  var r = __o(this), json, ok = true;
  try { json = r.json(); } catch (e) { ok = false; }
  if (!ok || arguments.length === 0) return this.__assert(ok, "expected response body to be valid JSON", "expected response body not to be JSON");
  if (__isObj(path)) return this.__assert(__deepEqual(json, path), "expected response body to equal " + __short(path), "expected response body to not equal " + __short(path));
  var found = __getPath(json, path);
  if (arguments.length < 2) return this.__assert(found.exists, "expected response body to have path " + __short(path), "expected response body to not have path " + __short(path));
  return this.__assert(found.exists && __deepEqual(found.value, value), "expected response body path " + __short(path) + " to be " + __short(value) + " but got " + __short(found.value), "expected response body path " + __short(path) + " to not be " + __short(value));
});
__method("responseTime", function () { return this; });
__method("jsonSchema", function (schema) {
  var r = __o(this), data;
  try { data = typeof r.json === "function" ? r.json() : r; } catch (e) { data = undefined; }
  var errors = __validateSchema(data, schema, "$");
  return this.__assert(errors.length === 0, "expected data to satisfy schema but found errors: " + errors.join("; "), "expected data to not satisfy schema");
});

// Minimal JSON-schema validator (type, enum, const, required, properties, additionalProperties, items, bounds, pattern).
function __validateSchema(v, s, path) {
  var errs = [];
  if (!__isObj(s)) return errs;
  if (s.type) {
    var types = [].concat(s.type), t = __type(v);
    var okType = types.some(function (x) { return x === t || (x === "integer" && t === "number" && Math.floor(v) === v) || (x === "number" && t === "number"); });
    if (!okType) { errs.push(path + " should be " + types.join("|") + " but is " + t); return errs; }
  }
  if (s.enum && !s.enum.some(function (e) { return __deepEqual(e, v); })) errs.push(path + " should be one of " + __short(s.enum));
  if ("const" in s && !__deepEqual(s.const, v)) errs.push(path + " should equal " + __short(s.const));
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) errs.push(path + " should be >= " + s.minimum);
    if (s.maximum !== undefined && v > s.maximum) errs.push(path + " should be <= " + s.maximum);
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) errs.push(path + " should have length >= " + s.minLength);
    if (s.maxLength !== undefined && v.length > s.maxLength) errs.push(path + " should have length <= " + s.maxLength);
    if (s.pattern && !new RegExp(s.pattern).test(v)) errs.push(path + " should match " + s.pattern);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errs.push(path + " should have >= " + s.minItems + " items");
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(path + " should have <= " + s.maxItems + " items");
    if (s.items) v.forEach(function (x, i) { errs = errs.concat(__validateSchema(x, s.items, path + "[" + i + "]")); });
  } else if (__isObj(v)) {
    (s.required || []).forEach(function (k) { if (!(k in v)) errs.push(path + " is missing required property " + k); });
    var props = s.properties || {};
    Object.keys(props).forEach(function (k) { if (k in v) errs = errs.concat(__validateSchema(v[k], props[k], path + "." + k)); });
    if (s.additionalProperties === false) Object.keys(v).forEach(function (k) { if (!(k in props)) errs.push(path + " has unexpected property " + k); });
  }
  return errs;
}

function __expect(v, message) { return new Assertion(v, message); }
__expect.fail = function (message) { throw new AssertionError(message || "expect.fail()"); };

// ---------------------------------------------------------------- variable scopes
var __scopes = __ctx.scopes;
var __precedence = ["local", "data", "environment", "collection", "globals"];
function __lookup(name) {
  for (var i = 0; i < __precedence.length; i++) {
    var bag = __scopes[__precedence[i]];
    if (bag && Object.prototype.hasOwnProperty.call(bag, name)) return { found: true, value: bag[name] };
  }
  return { found: false };
}
function __replaceIn(str, depth) {
  depth = depth || 0;
  if (typeof str !== "string") return str;
  return str.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (m, name) {
    var r = __lookup(name);
    if (r.found) return depth < 10 ? __replaceIn(String(r.value), depth + 1) : String(r.value);
    if (name.charAt(0) === "$") { var d = __host_dynamic(name); if (d !== undefined) return d; }
    return m;
  });
}
function __toStore(v) {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : (typeof v === "object" ? JSON.stringify(v) : String(v));
}
function VariableScope(name, readonly) {
  var bag = function () { return __scopes[name] || (__scopes[name] = {}); };
  this.get = function (k) { var b = bag(); return Object.prototype.hasOwnProperty.call(b, k) ? b[k] : undefined; };
  this.has = function (k) { return Object.prototype.hasOwnProperty.call(bag(), k); };
  this.toObject = function () { return Object.assign({}, bag()); };
  this.toJSON = this.toObject;
  this.replaceIn = function (s) { return __replaceIn(s); };
  this.unset = function (k) { delete bag()[k]; };
  if (!readonly) {
    this.set = function (k, v) { bag()[k] = __toStore(v); };
    this.clear = function () { __scopes[name] = {}; };
  }
}

// ---------------------------------------------------------------- headers / property lists
function PropertyList(items) {
  this.__items = (items || []).map(function (h) { return { key: h.key, value: h.value, disabled: !!h.disabled }; });
}
PropertyList.prototype.__find = function (k) {
  var low = String(k).toLowerCase();
  for (var i = 0; i < this.__items.length; i++) if (String(this.__items[i].key).toLowerCase() === low && !this.__items[i].disabled) return this.__items[i];
  return undefined;
};
PropertyList.prototype.get = function (k) { var h = this.__find(k); return h ? h.value : undefined; };
PropertyList.prototype.has = function (k, v) { var h = this.__find(k); return !!h && (arguments.length < 2 || h.value === v); };
PropertyList.prototype.one = function (k) { return this.__find(k); };
PropertyList.prototype.all = function () { return this.__items.filter(function (h) { return !h.disabled; }).map(function (h) { return { key: h.key, value: h.value }; }); };
PropertyList.prototype.toObject = function () { var o = {}; this.all().forEach(function (h) { o[h.key] = h.value; }); return o; };
PropertyList.prototype.toJSON = function () { return this.all(); };
PropertyList.prototype.each = function (fn) { this.all().forEach(fn); };
PropertyList.prototype.forEach = PropertyList.prototype.each;
PropertyList.prototype.map = function (fn) { return this.all().map(fn); };
PropertyList.prototype.filter = function (fn) { return this.all().filter(fn); };
PropertyList.prototype.count = function () { return this.all().length; };
PropertyList.prototype.add = function (h) { if (typeof h === "string") { var i = h.indexOf(":"); h = { key: h.slice(0, i).trim(), value: h.slice(i + 1).trim() }; } this.__items.push({ key: h.key, value: __toStore(h.value), disabled: !!h.disabled }); };
PropertyList.prototype.upsert = function (h) { var e = this.__find(h.key); if (e) e.value = __toStore(h.value); else this.add(h); };
PropertyList.prototype.remove = function (k) {
  var pred = typeof k === "function" ? k : function (h) { return String(h.key).toLowerCase() === String(k).toLowerCase(); };
  this.__items = this.__items.filter(function (h) { return !pred(h); });
};
PropertyList.prototype.clear = function () { this.__items = []; };

// ---------------------------------------------------------------- pm.request
function Url(raw) { this.update(raw); }
Url.prototype.update = function (raw) {
  this.__raw = String(raw);
  var q = this.__raw.indexOf("?");
  var qs = q >= 0 ? this.__raw.slice(q + 1).split("#")[0] : "";
  this.query = new PropertyList(qs ? qs.split("&").filter(Boolean).map(function (p) {
    var i = p.indexOf("=");
    var dec = function (s) { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (e) { return s; } };
    return i >= 0 ? { key: dec(p.slice(0, i)), value: dec(p.slice(i + 1)) } : { key: dec(p), value: "" };
  }) : []);
  this.__queryBase = JSON.stringify(this.query.__items);
};
Url.prototype.__base = function () { var q = this.__raw.indexOf("?"); return q >= 0 ? this.__raw.slice(0, q) : this.__raw.split("#")[0]; };
Url.prototype.toString = function () {
  if (JSON.stringify(this.query.__items) === this.__queryBase) return this.__raw;
  var enc = function (s) { return encodeURIComponent(s).replace(/%7B/gi, "{").replace(/%7D/gi, "}"); };
  var qs = this.query.__items.filter(function (p) { return !p.disabled; }).map(function (p) { return enc(p.key) + (p.value !== "" ? "=" + enc(p.value) : ""); }).join("&");
  return this.__base() + (qs ? "?" + qs : "");
};
Url.prototype.toJSON = Url.prototype.toString;
Url.prototype.getHost = function () { var m = /^[a-z]+:\/\/([^\/:?#]+)/i.exec(this.__base()); return m ? m[1] : ""; };
Url.prototype.getPath = function () { var m = /^[a-z]+:\/\/[^\/?#]+(\/[^?#]*)?/i.exec(this.__base()); return m && m[1] ? m[1] : "/"; };
Url.prototype.getQueryString = function () { var s = this.toString(), i = s.indexOf("?"); return i >= 0 ? s.slice(i + 1) : ""; };
Url.prototype.addQueryParams = function (params) { var self = this; [].concat(params).forEach(function (p) { if (typeof p === "string") { var i = p.indexOf("="); p = { key: p.slice(0, i), value: p.slice(i + 1) }; } self.query.add(p); }); };
Url.prototype.removeQueryParams = function (keys) { var self = this; [].concat(keys).forEach(function (k) { self.query.remove(k); }); };

function __makeRequest(r) {
  var url = new Url(r.url || "");
  var req = {
    id: r.id,
    name: r.name,
    method: r.method,
    headers: new PropertyList(r.headers),
    body: r.body ? JSON.parse(JSON.stringify(r.body)) : { mode: "none" },
    auth: r.auth,
    addHeader: function (h) { this.headers.add(h); },
    removeHeader: function (k) { this.headers.remove(k); },
    upsertHeader: function (h) { this.headers.upsert(h); },
    toJSON: function () { return { url: url.toString(), method: this.method, headers: this.headers.__items, body: this.body }; }
  };
  Object.defineProperty(req, "url", {
    enumerable: true,
    get: function () { return url; },
    set: function (v) { url = v instanceof Url ? v : new Url(typeof v === "object" && v && v.raw ? v.raw : String(v)); }
  });
  if (req.body) {
    req.body.update = function (v) {
      if (typeof v === "string") { req.body.mode = "raw"; req.body.raw = v; }
      else if (v && typeof v === "object") { Object.keys(v).forEach(function (k) { req.body[k] = v[k]; }); }
    };
    req.body.toString = function () { return req.body.mode === "raw" ? req.body.raw : JSON.stringify(req.body); };
  }
  return req;
}

// ---------------------------------------------------------------- pm.response
function __makeResponse(r) {
  if (!r) return undefined;
  var headers = new PropertyList(r.headers);
  var res = {
    __isResponse: true,
    code: r.code,
    status: r.status,
    headers: headers,
    responseTime: r.responseTime,
    responseSize: r.responseSize,
    cookies: new PropertyList((r.cookies || []).map(function (c) { return { key: c.name, value: c.value }; })),
    text: function () { return r.body; },
    json: function () { return JSON.parse(r.body); },
    reason: function () { return r.status; },
    dataURI: function () { return "data:" + (headers.get("content-type") || "application/octet-stream") + ";base64," + (r.bodyBase64 || btoa(r.body)); },
    toJSON: function () { return { code: r.code, status: r.status, headers: headers.all(), body: r.body, responseTime: r.responseTime }; }
  };
  Object.defineProperty(res, "stream", { get: function () { return r.body; } });
  Object.defineProperty(res, "to", { get: function () { return new Assertion(res).to; } });
  return res;
}

// ---------------------------------------------------------------- pm
function __recordTest(name, passed, error, skipped) { __state.tests.push({ name: String(name), passed: passed, error: error, skipped: !!skipped }); }
function __errMsg(e) { return e && e.message !== undefined ? (e.name && e.name !== "Error" && e.name !== "AssertionError" ? e.name + ": " : "") + e.message : String(e); }

var pm = {
  info: __ctx.info,
  environment: new VariableScope("environment"),
  globals: new VariableScope("globals"),
  collectionVariables: new VariableScope("collection"),
  iterationData: new VariableScope("data", true),
  variables: {
    get: function (k) { var r = __lookup(k); return r.found ? r.value : undefined; },
    has: function (k) { return __lookup(k).found; },
    set: function (k, v) { __scopes.local[k] = __toStore(v); },
    unset: function (k) { delete __scopes.local[k]; },
    replaceIn: function (s) { return __replaceIn(s); },
    toObject: function () {
      var o = {};
      for (var i = __precedence.length - 1; i >= 0; i--) Object.assign(o, __scopes[__precedence[i]] || {});
      return o;
    }
  },
  request: __makeRequest(__ctx.request),
  response: __makeResponse(__ctx.response),
  cookies: new PropertyList((__ctx.cookies || []).map(function (c) { return { key: c.name, value: c.value }; })),
  expect: __expect,
  test: function (name, fn) {
    if (typeof fn !== "function") { __recordTest(name, true, undefined, true); return pm; }
    try {
      var ret = fn();
      if (ret && typeof ret.then === "function") {
        var p = ret.then(function () { __recordTest(name, true); }, function (e) { __recordTest(name, false, __errMsg(e)); });
        __state.pending.push(p);
      } else __recordTest(name, true);
    } catch (e) { __recordTest(name, false, __errMsg(e)); }
    return pm;
  },
  sendRequest: function (req, cb) {
    var spec = typeof req === "string" ? { url: req, method: "GET" } : req;
    var payload = {
      url: String(spec.url),
      method: spec.method || "GET",
      header: spec.header || spec.headers || [],
      body: spec.body || null
    };
    if (payload.header && !Array.isArray(payload.header)) {
      payload.header = Object.keys(payload.header).map(function (k) { return { key: k, value: String(payload.header[k]) }; });
    }
    var p = __host_send(JSON.stringify(payload)).then(function (json) { return __makeResponse(JSON.parse(json)); });
    if (typeof cb === "function") {
      var done = p.then(function (res) { cb(null, res); }, function (err) { cb(err instanceof Error ? err : new Error(String(err)), null); });
      __state.pending.push(done);
    } else __state.pending.push(p.catch(function () {}));
    return p;
  },
  execution: {
    setNextRequest: function (name) { __state.nextRequest = name === null ? null : String(name); __state.nextRequestSet = true; },
    skipRequest: function () { __state.skip = true; },
    location: [__ctx.info.requestName]
  }
};
pm.test.skip = function (name) { __recordTest(name, true, undefined, true); return pm; };
pm.expect.fail = __expect.fail;

// Legacy Postman sandbox API.
var postman = {
  setNextRequest: pm.execution.setNextRequest,
  setEnvironmentVariable: function (k, v) { pm.environment.set(k, v); },
  getEnvironmentVariable: function (k) { return pm.environment.get(k); },
  clearEnvironmentVariable: function (k) { pm.environment.unset(k); },
  setGlobalVariable: function (k, v) { pm.globals.set(k, v); },
  getGlobalVariable: function (k) { return pm.globals.get(k); },
  clearGlobalVariable: function (k) { pm.globals.unset(k); }
};
var tests = {};
var environment = pm.environment.toObject();
var globals = pm.globals.toObject();
var data = pm.iterationData.toObject();
var responseCode = pm.response ? { code: pm.response.code, name: pm.response.status } : undefined;
var responseBody = pm.response ? pm.response.text() : undefined;
var responseTime = pm.response ? pm.response.responseTime : undefined;
var responseHeaders = pm.response ? pm.response.headers.toObject() : undefined;
var request = { url: String(pm.request.url), method: pm.request.method, headers: pm.request.headers.toObject(), data: pm.request.body && pm.request.body.raw };
globalThis.pm = pm;
globalThis.postman = postman;
globalThis.tests = tests;

// Wait until every pending promise (pm.sendRequest, setTimeout, async tests) settles, including ones created later.
function __drain() {
  if (__state.pending.length === 0) return Promise.resolve();
  var batch = __state.pending.splice(0, __state.pending.length);
  return Promise.all(batch.map(function (p) { return p.then(function () {}, function () {}); })).then(__drain);
}

function __finalize() {
  Object.keys(tests).forEach(function (k) { __recordTest(k, !!tests[k], tests[k] ? undefined : "tests[\"" + k + "\"] was falsy"); });
  var r = pm.request;
  return JSON.stringify({
    scopes: __scopes,
    tests: __state.tests,
    nextRequest: __state.nextRequest,
    nextRequestSet: __state.nextRequestSet,
    skip: __state.skip,
    request: { url: r.url.toString(), method: r.method, headers: r.headers.__items, body: r.body }
  });
}
`;
