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
var __skipSignal = {};
var __state = { visualization: __ctx.visualization, tests: [], nextRequest: undefined, nextRequestSet: false, skip: false, pending: [], vaultSet: {}, timers: {}, nextTimerId: 0, runRequestCount: 0, testCount: 0, asyncErrors: [], activeDone: undefined };

// ---------------------------------------------------------------- utilities
function __isObj(v) { return v !== null && typeof v === "object"; }
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
function __timer(fn, ms, args, repeat) {
  var id = ++__state.nextTimerId;
  var timer = { cancelled: false, onError: __state.activeDone };
  __state.timers[id] = timer;
  function tick() {
    return __host_sleep(Number(ms) || 0, id).then(function () {
      if (!repeat) delete __state.timers[id];
      if (timer.cancelled) return;
      try { fn.apply(null, args); } catch (e) { if (timer.onError) timer.onError(e); else throw e; }
      if (repeat && !timer.cancelled) return tick();
    });
  }
  __state.pending.push(tick());
  return id;
}
globalThis.setTimeout = function (fn, ms) { return __timer(fn, ms, Array.prototype.slice.call(arguments, 2), false); };
globalThis.setInterval = function (fn, ms) { return __timer(fn, ms, Array.prototype.slice.call(arguments, 2), true); };
globalThis.clearTimeout = globalThis.clearInterval = function (id) {
  var timer = __state.timers[id];
  if (timer) { timer.cancelled = true; __host_clear_sleep(id); delete __state.timers[id]; }
};
globalThis.btoa = function (value) {
  var text = String(value);
  for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) > 255) throw new TypeError("btoa expects Latin-1 text");
  return __libraries.Buffer.from(text, "latin1").toString("base64");
};
globalThis.atob = function (value) {
  var text = String(value).replace(/[\t\n\f\r ]/g, "");
  if (text.length % 4 === 0) text = text.replace(/==?$/, "");
  if (text.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(text)) throw new TypeError("Invalid base64 text");
  return __libraries.Buffer.from(text, "base64").toString("latin1");
};
var __libraries = __sandboxLibraries;
var __sdk = __libraries.sdk;
var Assertion = __libraries.chai.Assertion;
var __expect = __libraries.chai.expect;
globalThis.Buffer = __libraries.Buffer;
globalThis.require = function (name) {
  if (name === "chai") return __libraries.chai;
  if (name === "postman-collection") return __sdk;
  if (name === "buffer") return { Buffer: __libraries.Buffer };
  throw new Error("Module '" + name + "' is not available in the Postbox sandbox");
};
// Module factories and exports live only inside this fresh guest runtime.
var __moduleCache=Object.create(null),__moduleLoading=Object.create(null);
var __packageSnapshot=__ctx.scriptModules||{modules:{},aliases:{}};
var __builtins={chai:__libraries.chai,"postman-collection":__sdk,buffer:{Buffer:__libraries.Buffer},lodash:__libraries.lodash,ajv:__libraries.Ajv};
var __approved=Object.create(null);
__approvedPackageCatalog.forEach(function(item){__approved[item.specifier]=item.name;});
function __packageRequire(specifier){
 if(typeof specifier!=="string")throw new Error("pm.require expects a package specifier");
 if(Object.prototype.hasOwnProperty.call(__approved,specifier))return __builtins[__approved[specifier]];
 var canonical=Object.prototype.hasOwnProperty.call(__packageSnapshot.aliases,specifier)?__packageSnapshot.aliases[specifier]:specifier;
 if(!Object.prototype.hasOwnProperty.call(__packageSnapshot.modules,canonical))throw new Error("Package '"+specifier+"' is unavailable or not approved; use a pinned bundled or workspace package");
 if(Object.prototype.hasOwnProperty.call(__moduleCache,canonical))return __moduleCache[canonical].exports;
 if(__moduleLoading[canonical])throw new Error("Cyclic package import: "+canonical);
 __moduleLoading[canonical]=true;
 try{
  var module={exports:{}};
  var localRequire=function(name){if(name==="chai"||name==="postman-collection"||name==="buffer")return __builtins[name];return __packageRequire(name);};
  new Function("module","exports","require","pm", '"use strict";\n'+__packageSnapshot.modules[canonical].source)(module,module.exports,localRequire,pm);
  __moduleCache[canonical]=module;
  return module.exports;
 }finally{delete __moduleLoading[canonical];}
}
function __unsupported(name) {
  return function () { throw new Error(name + " is not supported in Postbox scripts"); };
}

// ---------------------------------------------------------------- variable scopes
var __scopes = __ctx.scopes;
var __precedence = ["local", "data", "environment", "collection", "globals"];
function __lookup(name) {
  if (__ctx.variableOverrides && Object.prototype.hasOwnProperty.call(__ctx.variableOverrides, name)) return { found: true, value: __ctx.variableOverrides[name] };
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
function __snapshotScopes() { return Object.assign({}, __scopes, { local: Object.assign({}, __scopes.local, __ctx.variableOverrides || {}) }); }
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
  this.unset = function (k) { if (readonly) throw new Error("pm.iterationData is read-only"); delete bag()[k]; };
  if (!readonly) {
    this.set = function (k, v) { bag()[k] = __toStore(v); };
    this.clear = function () { __scopes[name] = {}; };
  }
}

// ---------------------------------------------------------------- SDK objects
function __sdkAuth(auth) {
  if (!auth || auth.type === "inherit") return undefined;
  if (auth.type === "none") return { type: "noauth" };
  return auth;
}
function __coreAuth(auth, original) {
  if (!auth) return { type: "inherit" };
  var value = typeof auth.toJSON === "function" ? auth.toJSON() : auth;
  if (value.type === "noauth") return { type: "none" };
  original = original || {};
  var result = { type: value.type };
  var parameters = value[value.type];
  var values = Array.isArray(parameters) ? parameters.reduce(function (out, item) {
    Object.defineProperty(out, item.key, { value: item.value, writable: true, enumerable: true, configurable: true });
    return out;
  }, {}) : parameters;
  var defaults = value.type === "oauth2" ? {
    grantType: "manual", accessTokenUrl: "", clientId: "", clientSecret: "", scope: "",
    clientAuthentication: "header", accessToken: "", headerPrefix: "Bearer"
  } : value.type === "hawk" ? { algorithm: "sha256" } : {};
  result[value.type] = Object.assign(defaults, original.type === value.type ? original[value.type] : {}, values);
  if (value.type === "oauth2") {
    if (values.grant_type !== undefined) result.oauth2.grantType = values.grant_type === "client_credentials" ? "client_credentials" : values.grant_type === "password_credentials" ? "password" : "manual";
    if (values.client_authentication !== undefined) result.oauth2.clientAuthentication = values.client_authentication === "body" ? "body" : "header";
  }
  return result;
}
function __makeRequest(r) {
  var body = JSON.parse(JSON.stringify(r.body || { mode: "none" }));
  ["formdata", "urlencoded"].forEach(function (key) {
    if (Array.isArray(body[key])) body[key].forEach(function (item) {
      if (item.enabled !== undefined) item.disabled = !item.enabled;
    });
  });
  var req = new __sdk.Request({ url: r.url, method: r.method, header: r.headers, body: body, auth: __sdkAuth(r.auth) });
  req.id = r.id;
  req.name = r.name;
  // Preserve Postbox's raw-language hint and the existing string body-update extension.
  if (req.body) {
    req.body.language = body.language;
    var updateBody = req.body.update.bind(req.body);
    req.body.update = function (value) { return updateBody(typeof value === "string" ? { mode: "raw", raw: value } : value); };
  }
  return req;
}
function __makeResponse(r) {
  if (!r) return undefined;
  var response = new __sdk.Response({
    code: r.code, status: r.status, header: r.headers, body: r.body,
    stream: r.bodyBase64 ? __libraries.Buffer.from(r.bodyBase64, "base64") : undefined,
    responseTime: r.responseTime, cookie: r.cookies || []
  });
  response.responseSize = r.responseSize;
  Object.defineProperty(response, "to", { get: function () { return new Assertion(response).to; } });
  return response;
}
function __serializeRequest(r) {
  if (r.proxy || r.certificate) throw new Error("Script proxy and certificate mutations are not supported");
  var body = r.body && r.body.toJSON ? r.body.toJSON() : r.body;
  if (body && body.mode === "file") throw new Error("Script file bodies are not supported; attach files in the request editor");
  if (body && r.body.language) body.language = r.body.language;
  if (body && body.mode === "binary") body.binary = __ctx.request.body && __ctx.request.body.binary;
  return {
    url: (r.url instanceof __sdk.Url ? r.url : new __sdk.Url(r.url)).toString(), method: r.method,
    headers: r.headers.toJSON().map(function (header) { return { key: header.key, value: header.value, disabled: !!header.disabled }; }),
    body: body, auth: __coreAuth(r.auth, __ctx.request.auth)
  };
}
// ---------------------------------------------------------------- pm
function __recordTest(name, passed, error, skipped) { __state.tests.push({ name: String(name), passed: passed, error: error, skipped: !!skipped }); }
function __errMsg(e) { return e && e.message !== undefined ? (e.name && e.name !== "Error" && e.name !== "AssertionError" ? e.name + ": " : "") + e.message : String(e); }

var __vault = __ctx.vault || {};
var pm = {
  info: __ctx.info,
  // Secrets vault: only secrets an administrator marked for script access are present.
  vault: Object.freeze({
    get: function (name) { return Object.prototype.hasOwnProperty.call(__vault, name) ? __vault[name] : undefined; },
    has: function (name) { return Object.prototype.hasOwnProperty.call(__vault, name); },
    // Replaces the value of a secret that allows script access (it cannot create or delete secrets).
    set: function (name, value) {
      if (!Object.prototype.hasOwnProperty.call(__vault, name))
        throw new Error("pm.vault.set can only change an existing secret that allows script access: " + String(name));
      var text = value === undefined || value === null ? "" : typeof value === "string" ? value : String(value);
      if (!text) throw new Error("pm.vault.set needs a value");
      __vault[name] = text;
      __state.vaultSet[name] = text;
    },
    unset: __unsupported("pm.vault.unset (delete secrets in Postbox settings)"),
  }),
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
      return Object.assign(o, __ctx.variableOverrides || {});
    }
  },
  request: __makeRequest(__ctx.request),
  response: __makeResponse(__ctx.response),
  cookies: (function () {
    var list = __ctx.cookies || [];
    return { get: function (name) { var cookie = list.find(function (item) { return item.name === String(name); }); return cookie ? cookie.value : undefined; },
      has: function (name) { return list.some(function (item) { return item.name === String(name); }); },
      toObject: function () { var values = {}; list.forEach(function (item) {
        if (!Object.prototype.hasOwnProperty.call(values, item.name)) Object.defineProperty(values, item.name, { value: item.value, enumerable: true, writable: true, configurable: true });
      }); return values; }
    };
  })(),
  visualizer: {
    set: function(template, data, options) {
      if(typeof template!=="string")throw new Error("pm.visualizer.set expects a template string");
      if(template.length>131072)throw new Error("Visualization template exceeds 128 KiB");
      var value=JSON.parse(JSON.stringify({template:template,data:data===undefined?{}:data,options:options||{}}));
      if(JSON.stringify(value).length>393216)throw new Error("Visualization data exceeds its limit");
      __state.visualization=value;__state.visualizationSet=true;
    },
    get: function() {return __state.visualization?JSON.parse(JSON.stringify(__state.visualization)):null;},
    clear: function(){__state.visualization=null;__state.visualizationSet=true;}
  },
  datasets: __unsupported("pm.datasets"),
  mock: { create: __unsupported("pm.mock") },
  state: { get: __unsupported("pm.state"), set: __unsupported("pm.state"), unset: __unsupported("pm.state"), clear: __unsupported("pm.state") },
  require: __packageRequire,
  expect: __expect,
  test: function (name, fn) {
    __state.testCount++;
    if (typeof fn !== "function") { __recordTest(name, true); return pm; }
    try {
      if (fn.length > 0) {
        var settled = false;
        var finish;
        var pending = new Promise(function (resolve) { finish = resolve; });
        var done = function (err) {
          if (settled) return;
          settled = true;
          __recordTest(name, !err, err ? __errMsg(err) : undefined);
          finish();
        };
        __state.pending.push(pending);
        var callbackResult;
        var previousDone = __state.activeDone;
        __state.activeDone = done;
        try { callbackResult = fn(done); } catch (e) { done(e); return pm; }
        finally { __state.activeDone = previousDone; }
        if (callbackResult && typeof callbackResult.then === "function")
          callbackResult.then(function () { done(); }, done);
        return pm;
      }
      var ret = fn();
      if (ret && typeof ret.then === "function") {
        var p = ret.then(function () { __recordTest(name, true); }, function (e) { __recordTest(name, false, __errMsg(e)); });
        __state.pending.push(p);
      } else __recordTest(name, true);
    } catch (e) { if (e === __skipSignal) throw e; __recordTest(name, false, __errMsg(e)); }
    return pm;
  },
  sendRequest: function (req, cb) {
    var definition = typeof req === "string" ? { url: req, method: "GET" } : req;
    var spec;
    if (__sdk.Request.isRequest(definition)) spec = definition;
    else {
      var headers = definition.header || definition.headers;
      if (headers && typeof headers.toJSON === "function") headers = headers.toJSON();
      else if (headers && typeof headers === "object" && !Array.isArray(headers))
        headers = Object.keys(headers).map(function (key) { return { key: key, value: String(headers[key]) }; });
      spec = new __sdk.Request(Object.assign({}, definition, { header: headers }));
    }
    var payload = {
      url: spec.url.toString(), method: spec.method || "GET",
      header: spec.headers.toJSON(), body: spec.body ? spec.body.toJSON() : null,
      auth: __coreAuth(spec.auth)
    };
    var p = __host_send(JSON.stringify(payload), JSON.stringify(__snapshotScopes())).then(function (json) { return __makeResponse(JSON.parse(json)); });
    if (typeof cb === "function") {
      var onError = __state.activeDone;
      var invoke = function (err, res) {
        try { cb(err, res); } catch (e) { if (onError) onError(e); else throw e; }
      };
      var done = p.then(function (res) { invoke(null, res); }, function (err) { invoke(err instanceof Error ? err : new Error(String(err)), null); });
      __state.pending.push(done);
    } else __state.pending.push(p.catch(function () {}));
    return p;
  },
  execution: {
    runRequest: function (requestId, options) {
      if (++__state.runRequestCount > 10)
        return Promise.reject(new Error("Script exceeded the pm.execution.runRequest quota of 10"));
      var before = JSON.parse(JSON.stringify(__snapshotScopes()));
      var p = __host_run_request(String(requestId), JSON.stringify(options || {}), JSON.stringify(before)).then(function (json) {
        var result = JSON.parse(json);
        var response = result;
        if (result && Object.prototype.hasOwnProperty.call(result, "response")) {
          response = result.response;
          // Apply only child changes so concurrent calls do not restore stale snapshots.
          Object.keys(result.scopes).forEach(function (scope) {
            var after = result.scopes[scope], previous = before[scope];
            Object.keys(previous).forEach(function (key) {
              if (!Object.prototype.hasOwnProperty.call(after, key)) delete __scopes[scope][key];
            });
            Object.keys(after).forEach(function (key) {
              if (after[key] !== previous[key]) Object.defineProperty(__scopes[scope], key, { value: after[key], writable: true, enumerable: true, configurable: true });
            });
          });
        }
        if (result && result.error) throw new Error(result.error);
        return response === null ? null : __makeResponse(response);
      });
      __state.pending.push(p.catch(function () {}));
      return p;
    },
    setNextRequest: function (name) { __state.nextRequest = name === null ? null : String(name); __state.nextRequestSet = true; },
    skipRequest: function () {
      if (__ctx.info.eventName !== "prerequest") throw new TypeError("pm.execution.skipRequest is only available in pre-request scripts");
      __state.skip = true;
      throw __skipSignal;
    },
    location: (function () {
      var path = Array.isArray(__ctx.info.location) && __ctx.info.location.length
        ? __ctx.info.location.slice()
        : [__ctx.info.requestName];
      Object.defineProperty(path, "current", { get: function () { return __ctx.info.locationCurrent || path[path.length - 1]; } });
      return path;
    })()
  }
};
pm.cookies.getAll = function () { return pm.cookies.toObject(); };
pm.cookies.jar = __unsupported("pm.cookies.jar");
pm.message = { toJSON: __unsupported("pm.message"), text: __unsupported("pm.message"), json: __unsupported("pm.message") };
pm.test.index = function () { return __state.testCount; };
pm.test.skip = function (name) { __state.testCount++; __recordTest(name, true, undefined, true); return pm; };
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
  if (__state.pending.length === 0) return __state.asyncErrors.length ? Promise.reject(__state.asyncErrors[0]) : Promise.resolve();
  var batch = __state.pending.splice(0, __state.pending.length);
  return Promise.all(batch.map(function (p) { return p.then(function () {}, function (error) { __state.asyncErrors.push(error); }); })).then(__drain);
}

function __finalize() {
  Object.keys(tests).forEach(function (k) { __recordTest(k, !!tests[k], tests[k] ? undefined : "tests[\"" + k + "\"] was falsy"); });
  var r = pm.request;
  return JSON.stringify({
    scopes: __scopes,
    visualization: __state.visualization,
    visualizationSet: __state.visualizationSet===true,
    tests: __state.tests,
    nextRequest: __state.nextRequest,
    nextRequestSet: __state.nextRequestSet,
    skip: __state.skip,
    vaultSet: __state.vaultSet,
    request: __serializeRequest(r)
  });
}
`;
