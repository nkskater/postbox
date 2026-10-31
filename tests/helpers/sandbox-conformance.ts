import type { PostmanCollection } from "@/core/convert/postman";

/** Shared script contract exercised through Send, collection runs and the standalone CLI. */
export const helperPreScript = `pm.globals.set("helperId", pm.info.requestId); if (pm.variables.get("value") === "override") pm.variables.set("value", "should-not-win");`;
export const helperTestScript = `
pm.environment.set("childResult", "yes");
pm.test("saved request assertion", () => pm.response.to.have.status(200));
if (pm.variables.get("value") === "override") pm.execution.setNextRequest(null);
`;
export const conformancePreScript = `
const sdk = require("postman-collection");
pm.request.url = new sdk.Url(pm.request.url.toJSON());
pm.request.url.hash = "kept";
pm.request.auth = pm.request.auth || new sdk.RequestAuth({ type: "noauth" });
pm.request.auth.use("bearer", { token: "conformance-token" });
pm.request.method = "POST";
pm.request.body.update({ mode: "urlencoded", urlencoded: [{ key: "field", value: "first" }] });
pm.request.body.urlencoded.upsert({ key: "field", value: "second" });
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
  pm.expect(pm.response.json().headers.authorization).to.equal("Bearer conformance-token");
  pm.expect(pm.response.json().body).to.equal("field=second");
  pm.expect(pm.request.url.hash).to.equal("kept");
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
pm.test("Chai contracts", () => {
  pm.expect(new Date(0)).not.to.deep.equal(new Date(1));
  pm.expect(/a/i).not.to.deep.equal(/a/g);
  pm.expect(new Map([["id", 1]])).to.deep.equal(new Map([["id", 1]]));
  pm.expect(new Set([1, 2])).to.deep.equal(new Set([2, 1]));
  pm.expect(() => { throw new TypeError("boom"); }).to.throw(TypeError, /boom/);
  pm.expect(() => pm.expect(true).to.be.unknownAssertion).to.throw();
});
pm.test("schema drafts and references", () => {
  pm.expect({ id: "A-1" }).to.have.jsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { id: { type: "string", pattern: "^A-" } },
    type: "object", properties: { id: { $ref: "#/$defs/id" } }, required: ["id"],
    additionalProperties: false,
  });
  pm.expect({ id: 1 }).not.to.have.jsonSchema({ allOf: [{ type: "string" }] });
  pm.expect("anything").not.to.have.jsonSchema(false);
});
const sdkResponse = await pm.sendRequest(new (require("postman-collection").Request)({
  url: "{{base}}/echo", auth: { type: "bearer", bearer: [{ key: "token", value: "sdk-token" }] },
}));
pm.test("SDK sendRequest", () => pm.expect(sdkResponse.json().headers.authorization).to.equal("Bearer sdk-token"));
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
