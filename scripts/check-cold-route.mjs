// Run after the container health check, before any workspace/tree requests.
import { performance } from "node:perf_hooks";

const base = process.argv[2];
if (!base) throw new Error("Usage: node scripts/check-cold-route.mjs http://127.0.0.1:3000");
// Sends POSTBOX_TOKEN as a bearer token when set (the container smoke test runs with authentication on).
const headers = process.env.POSTBOX_TOKEN ? { Authorization: `Bearer ${process.env.POSTBOX_TOKEN}` } : {};
const get = async (route) => {
  const response = await fetch(new URL(route, base), { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
};
const workspaces = await get("/api/workspaces");
if (!workspaces[0]?.id) throw new Error("Default workspace missing");
const route = `/api/workspaces/${encodeURIComponent(workspaces[0].id)}/tree`;
const started = performance.now();
const tree = await get(route);
const elapsed = performance.now() - started;
if (!Array.isArray(tree?.folders) || !Array.isArray(tree?.requests))
  throw new Error("Invalid workspace tree response");
console.log(`Cold workspace tree route: ${elapsed.toFixed(1)} ms (limit <500 ms)`);
if (elapsed >= 500) throw new Error(`Cold route exceeded 500 ms: ${elapsed.toFixed(1)} ms`);
