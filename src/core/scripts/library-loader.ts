/** Package source is supplied by the host; evaluation and cached exports stay in the guest. */
export const LIBRARY_LOADER_SOURCE = String.raw`
var __approvedCache = Object.create(null);
var __approvedLoading = Object.create(null);
function __loadApproved(name) {
  if (Object.prototype.hasOwnProperty.call(__approvedCache, name)) return __approvedCache[name];
  if (__approvedLoading[name]) throw new Error("Cyclic bundled library: " + name);
  __approvedLoading[name] = true;
  try {
    return __approvedCache[name] = __host_load_library(name);
  } finally { delete __approvedLoading[name]; }
}
var __sandboxLibraries = {};
Object.defineProperties(__sandboxLibraries, {
  chai: { get: function () { return __loadApproved("core").chai; } },
  sdk: { get: function () { return __loadApproved("postman-collection"); } },
  Buffer: { get: function () { return __loadApproved("buffer").Buffer; } },
  lodash: { get: function () { return __loadApproved("lodash"); } },
  Ajv: { get: function () { return __loadApproved("ajv"); } }
});
`;
