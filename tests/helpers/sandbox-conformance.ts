import type { PostmanCollection } from "@/core/convert/postman";

/** Shared script contract exercised through Send, collection runs and the standalone CLI. */
export const helperPreScript = `pm.globals.set("helperId", pm.info.requestId);`;
export const helperTestScript = `
pm.environment.set("childResult", "yes");
pm.test("saved request assertion", () => pm.response.to.have.status(200));
if (pm.variables.get("value") === "override") pm.execution.setNextRequest(null);
`;
export const conformancePreScript = `
pm.request.headers.upsert({ key: "X-Conformance", value: "yes" });
pm.request.url.query.upsert({ key: "mutated", value: "yes" });
pm.test("callback completion", (done) => setTimeout(() => {
  pm.expect([1, 1, 2]).to.have.members([2, 1, 1]);
  done();
}, 1));
`;
export const conformanceTestScript = `
pm.test("SDK mutations reach HTTP", () => {
  pm.expect(pm.response.json().headers["x-conformance"]).to.equal("yes");
  pm.expect(pm.response.json().query.mutated).to.equal("yes");
});
const referenced = await pm.execution.runRequest(pm.globals.get("helperId"), { variables: { value: "override" } });
pm.test("saved response and scope propagation", () => {
  pm.expect(referenced.json().query.value).to.equal("override");
  pm.expect(pm.environment.get("childResult")).to.equal("yes");
  pm.expect(pm.variables.get("value")).to.equal("root");
});
pm.test("location", () => {
  pm.expect(pm.execution.location).to.deep.equal(["Conformance", "Root"]);
  pm.expect(pm.execution.location.current).to.equal("Root");
});
pm.test("isolation", () => {
  pm.expect(typeof process).to.equal("undefined");
  pm.expect(typeof fetch).to.equal("undefined");
  pm.expect(() => require("node:fs")).to.throw();
});
`;
export function conformanceCollection(base: string): PostmanCollection {
  return {
    info: { name: "Conformance" },
    variable: [
      { key: "base", value: base },
      { key: "value", value: "root" },
    ],
    item: [
      {
        name: "Helper",
        request: { method: "GET", url: "{{base}}/echo?value={{value}}" },
        event: [
          { listen: "prerequest", script: { exec: [helperPreScript] } },
          { listen: "test", script: { exec: [helperTestScript] } },
        ],
      },
      {
        name: "Root",
        request: { method: "GET", url: "{{base}}/echo" },
        event: [
          { listen: "prerequest", script: { exec: [conformancePreScript] } },
          { listen: "test", script: { exec: [conformanceTestScript] } },
        ],
      },
    ],
  };
}
