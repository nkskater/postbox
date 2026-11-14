import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/server/auth";
import { REST_POLICIES } from "@/server/access-policy";

function routeTemplates(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeTemplates(file);
    if (entry.name !== "route.ts") return [];
    return ["/api/" + path.relative(path.resolve("src/app/api"), directory).replaceAll("\\", "/")];
  });
}
const registered = routeTemplates(path.resolve("src/app/api"));
const pathnameOf = (key: string) => key.slice(key.indexOf(" ") + 1);
function samples(template: string): string[] {
  const paths = ["sample", "with-dash", "with_underscore", "Case01"].flatMap((id) => {
    const concrete = template.replace(/\[(?!\[|\.\.\.)[^\]]+\]/g, id);
    return ["", "child", "child/grandchild"].map((tail) =>
      concrete
        .replace(/\/\[\[\.\.\.[^\]]+\]\]/g, tail ? "/" + tail : "")
        .replace(/\[\.\.\.[^\]]+\]/g, tail || id),
    );
  });
  return [...new Set(paths)];
}

/** The gate classifies paths; methods and receiver credentials are enforced inside route handlers. */
function disagreements(
  gate: (pathname: string) => boolean,
  policies: Record<string, { source: string }> = REST_POLICIES,
): string[] {
  const publicTemplates = new Set(
    Object.entries(policies)
      .filter(([, policy]) => policy.source === "public")
      .map(([key]) => pathnameOf(key)),
  );
  // Include actual files too: removing a policy must not hide its still-public route from this check.
  const templates = new Set([...registered, ...Object.keys(policies).map(pathnameOf)]);
  return [...templates].flatMap((template) =>
    samples(template).filter((pathname) => gate(pathname) !== publicTemplates.has(template)),
  );
}

describe("public API authentication boundary", () => {
  it("keeps every registered API path consistent with its public route policy", () => {
    expect(disagreements(isPublicPath)).toEqual([]);
  });

  it("detects additions or removals made only in the authentication gate", () => {
    expect(disagreements((pathname) => pathname === "/api/workspaces" || isPublicPath(pathname))).toContain(
      "/api/workspaces",
    );
    expect(disagreements((pathname) => pathname !== "/api/health" && isPublicPath(pathname))).toContain(
      "/api/health",
    );
  });

  it("detects additions or removals made only in the public policy inventory", () => {
    expect(
      disagreements(isPublicPath, { ...REST_POLICIES, "GET /api/new-contract": { source: "public" } }),
    ).toContain("/api/new-contract");
    const { "GET /api/health": _removed, ...withoutHealth } = REST_POLICIES;
    expect(disagreements(isPublicPath, withoutHealth)).toContain("/api/health");
  });
});
