import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { importSoapUi, isSoapUiXml } from "@/core/convert/soapui";
import { exportPostmanCollection, importPostmanCollection } from "@/core/convert/postman";
import { prepareRequest } from "@/core/http/prepare";
import { Resolver, emptyScopes } from "@/core/variables/resolver";
import type { FolderNode, RequestNode } from "@/core/types";
const source = fs.readFileSync(new URL("./fixtures/soapui/migration.xml", import.meta.url), "utf8");
const expected = JSON.parse(
  fs.readFileSync(new URL("./fixtures/soapui/migration.expected.json", import.meta.url), "utf8"),
);
function requests(root: FolderNode, path = ""): { path: string; node: RequestNode }[] {
  const prefix = path ? `${path}/${root.name}` : root.name;
  return root.children.flatMap((child) =>
    child.kind === "folder" ? requests(child, prefix) : [{ path: prefix, node: child }],
  );
}
const wrap = (xml: string) =>
  `<con:soapui-project xmlns:con="http://eviware.com/soapui/config" name="Test">${xml}</con:soapui-project>`;

describe("SoapUI XML migration", () => {
  it("matches the golden hierarchy, request snapshots and source accounting", () => {
    const result = importSoapUi(source);
    expect(result.root.name).toBe(expected.name);
    expect(result.sourceCounts).toEqual(expected.sourceCounts);
    expect(
      requests(result.root).map(({ path, node: { name, method, url } }) => ({ path, name, method, url })),
    ).toEqual(expected.requests);
    expect(result.sourceCounts.requestDefinitions + result.sourceCounts.requestTestSteps).toBe(
      result.sourceCounts.convertedRequests + result.sourceCounts.skippedRequests,
    );
    expect(importSoapUi(source)).toEqual(result);
  });
  it("preserves SOAP 1.1/1.2 actions, CDATA, entities and whitespace", () => {
    const result = importSoapUi(source),
      all = requests(result.root);
    const soap = all.find((r) => r.node.name === "SOAP 1.1")!.node;
    expect(soap.headers).toEqual(
      expect.arrayContaining([
        { key: "Content-Type", value: "text/xml; charset=utf-8", enabled: true },
        { key: "SOAPAction", value: '"urn:Echo"', enabled: true },
      ]),
    );
    expect(soap.body).toEqual({
      mode: "raw",
      language: "xml",
      raw: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">\n  <s:Body><Echo>café &amp; exact whitespace</Echo></s:Body>\n</s:Envelope>',
    });
    const soap12 = all.find((r) => r.node.name === "SOAP 1.2")!.node;
    expect(soap12.headers).toContainEqual({
      key: "Content-Type",
      value: 'application/soap+xml; charset=utf-8; action="urn:Submit"',
      enabled: true,
    });
    expect(soap12.headers.some((h) => h.key === "SOAPAction")).toBe(false);
  });
  it("preserves nested REST paths, request overrides, empty query values and escaped headers", () => {
    const req = requests(importSoapUi(source).root).find((r) => r.node.name === "Get pet")!.node;
    expect(req.url.endsWith("?q=")).toBe(true);
    expect(req.params).toContainEqual({ key: "q", value: "", enabled: true });
    expect(req.headers).toContainEqual({ key: "X-Literal", value: "A & B", enabled: true });
    expect(req.auth).toEqual({
      type: "basic",
      basic: { username: "{{username}}", password: "{{password}}" },
    });
  });
  it("maps project/suite/case/properties-step scopes without evaluating scripts or external scopes", () => {
    const result = importSoapUi(source),
      all = requests(result.root);
    expect(all.find((r) => r.node.name === "Read in case")!.node.url).toContain("{{suite_1.case_1.petId}}");
    expect(all.find((r) => r.node.name === "SOAP in case")!.node.body).toMatchObject({
      raw: "<Envelope><Body>{{suite_1.case_1.step_1.tag}}</Body></Envelope>",
    });
    expect(result.variables).toContainEqual({
      key: "suite_1.category",
      value: "public",
      enabled: true,
      type: "default",
    });
    const unknown = importSoapUi(
      source.replace("${Inputs#tag}", "${#Env#API_TOKEN} ${=System.exit(1)} ${Previous#Response#//id}"),
    );
    expect(unknown.diagnostics.some((d) => d.code === "unsupported-property")).toBe(true);
    expect(JSON.stringify(unknown.root)).toContain("${#Env#API_TOKEN}");
    expect(JSON.stringify(result.root)).not.toContain("must not execute");
    expect(all.every((r) => !r.node.preRequestScript && !r.node.testScript)).toBe(true);
  });
  it("omits recognized credentials by default and imports them only when explicitly requested", () => {
    const omitted = importSoapUi(source),
      included = importSoapUi(source, { includeCredentials: true });
    const safe = JSON.stringify(omitted);
    for (const secret of ["alice", "secret-value", "token-value", "inline-secret", "sensitive-bearer"])
      expect(safe).not.toContain(secret);
    for (const key of ["username", "password", "token"])
      expect(omitted.variables.find((v) => v.key === key)).toMatchObject({ type: "secret", value: "" });
    expect(included.variables.find((v) => v.key === "username")).toMatchObject({
      type: "secret",
      value: "alice",
    });
    expect(included.variables.find((v) => v.key === "password")).toMatchObject({
      type: "secret",
      value: "secret-value",
    });
    expect(included.variables.some((v) => v.type === "secret" && v.value === "Bearer sensitive-bearer")).toBe(
      true,
    );
    expect(included.diagnostics.some((d) => d.code === "credentials-omitted")).toBe(false);
    expect(included.variables.some((v) => v.type === "secret" && v.value === "inline-secret")).toBe(true);
    expect(JSON.stringify(included.root)).not.toContain("inline-secret");
  });
  it("reports unsupported assertions, scripts, disabled steps, attachments and workflows", () => {
    const { diagnostics } = importSoapUi(source);
    expect(diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        "unsupported-assertion",
        "unsupported-script",
        "unsupported-step",
        "disabled-step",
        "unsupported-attachment",
        "unsupported-soap-security",
        "unsupported-feature",
        "migration-review",
      ]),
    );
    expect(diagnostics.some((d) => d.path.includes("Workflow/Case"))).toBe(true);
  });
  it("prepares the imported basic auth, variables, URL and SOAP message through the app engine", async () => {
    const result = importSoapUi(source, { includeCredentials: true }),
      scope = emptyScopes();
    scope.collection = Object.fromEntries(result.variables.map((v) => [v.key, v.value]));
    const all = requests(result.root),
      rest = all.find((r) => r.node.name === "Get pet")!.node;
    const prepared = await prepareRequest(
      { ...rest, headers: rest.headers.filter((h) => h.key.toLowerCase() !== "authorization") },
      [result.root],
      new Resolver(scope),
      undefined,
      {
        offline: true,
      },
    );
    expect(prepared.prepared.url).toBe("https://api.test/v1/pets/42?q=");
    expect(prepared.prepared.headers).toContainEqual([
      "Authorization",
      `Basic ${Buffer.from("alice:secret-value").toString("base64")}`,
    ]);
    const soap = all.find((r) => r.node.name === "SOAP in case")!.node;
    const sent = await prepareRequest(soap, [result.root], new Resolver(scope), undefined, { offline: true });
    expect(sent.prepared.body?.toString()).toBe("<Envelope><Body>round-trip</Body></Envelope>");
  });
  it("round-trips migrated requests and secret references through Postman export", () => {
    const result = importSoapUi(source, { includeCredentials: true });
    const back = importPostmanCollection(
      exportPostmanCollection(result.root, result.variables, {
        includeSecrets: true,
        includeCredentials: true,
      }),
    );
    const shape = (root: FolderNode) =>
      requests(root).map(({ path, node }) => ({
        path,
        name: node.name,
        method: node.method,
        url: node.url,
        body: node.body,
        auth: node.auth,
        headers: node.headers.map(({ key, value, enabled }) => ({ key, value, enabled })),
      }));
    expect(shape(back.root)).toEqual(shape(result.root));
    expect(back.variables).toEqual(result.variables);
  });
  it.each([
    "<other/>",
    "<soapui-project>",
    wrap("<x>&unknown;</x>"),
    '<!DOCTYPE x [<!ENTITY remote SYSTEM "file:///etc/passwd">]>' + wrap("<properties>&remote;</properties>"),
  ])("rejects malformed/non-project/entity input without partial conversion", (xml) => {
    expect(() => importSoapUi(xml)).toThrow();
  });
  it("bounds input size, nesting, element counts and diagnostic output", () => {
    expect(() => importSoapUi(wrap(" ".repeat(10 * 1024 * 1024)))).toThrow(/10 MB/);
    expect(() => importSoapUi(wrap("<x>".repeat(100) + "</x>".repeat(100)))).toThrow();
    expect(() => importSoapUi(wrap("<x/>".repeat(50_001)))).toThrow(/element limit/);
    const result = importSoapUi(
      wrap(
        '<testSuite name="Suite"><testCase name="Case">' +
          Array.from(
            { length: 550 },
            (_, i) =>
              `<testStep type="groovy" name="Step ${i}"><config><script>not executable</script></config></testStep>`,
          ).join("") +
          "</testCase></testSuite>",
      ),
    );
    expect(result.sourceCounts.unsupportedTestSteps).toBe(550);
    expect(result.diagnostics).toHaveLength(500);
    expect(result.diagnostics.at(-1)?.code).toBe("diagnostics-truncated");
  });
  it("diagnoses missing REST references and non-HTTP endpoints without silent request loss", () => {
    const result = importSoapUi(
      wrap(
        '<interface type="wsdl" name="Local"><operation name="x"><call name="unsupported"><endpoint>jms:queue:test</endpoint><request>message</request></call></operation></interface><testSuite><testCase><testStep type="restrequest" name="Missing"><config service="absent" resourcePath="/x" methodName="Read"><restRequest/></config></testStep></testCase></testSuite>',
      ),
    );
    expect(result.sourceCounts).toMatchObject({
      requestDefinitions: 1,
      requestTestSteps: 1,
      skippedRequests: 2,
      convertedRequests: 0,
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["unsupported-endpoint", "missing-service-reference", "no-requests"]),
    );
  });
  it("detects prefixed, unprefixed and BOM/comment projects without matching JSON text", () => {
    expect(isSoapUiXml(source)).toBe(true);
    expect(isSoapUiXml("\uFEFF <!-- comment --> " + wrap(""))).toBe(true);
    expect(isSoapUiXml('<soapui-project name="Empty"/>')).toBe(true);
    expect(isSoapUiXml("<soapui-project/>")).toBe(true);
    expect(isSoapUiXml(JSON.stringify({ body: source }))).toBe(false);
  });
});
