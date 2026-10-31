# Import SoapUI projects

Open **Import → SoapUI**, upload a project XML file or paste XML, then select
**Preview SoapUI**. The preview shows collection/request counts, source counts,
and diagnostics before any data is saved. Select **Import SoapUI** to confirm.
Changing the source, workspace or credential choice requires another preview.
Successful imports cannot be submitted again from the same preview, including
when the sidebar fails to refresh after the server commits the import.

The normal file, text and link import paths also recognize SoapUI XML. Use the
SoapUI tab when you want to review a preview before importing. Project files
must be self-contained; composite project directories and separate attachment
files are not loaded automatically.

## Supported migration

| Source           | Imported behavior                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| REST services    | Service/resource hierarchy, nested resource paths, method and saved request names, selected endpoints, request body and media type |
| REST parameters  | Inherited resource/method defaults, request overrides, template/query/header parameters, explicit empty query values               |
| SOAP services    | Interface/operation/call hierarchy, saved XML envelopes, SOAP 1.1 Content-Type/SOAPAction and SOAP 1.2 action parameter            |
| Functional tests | Suite/case folders and saved SOAP, REST and ordinary HTTP request steps, in request-step order                                     |
| Properties       | Project, suite, case and Properties TestStep values, mapped to collection variables with distinct names for local scopes           |
| Authentication   | Basic/preemptive, Digest, NTLM and bearer credentials where explicitly represented; source headers and inherited service auth      |
| Endpoints        | Declared endpoints retained as collection variables; explicit request endpoints and property references retained                   |

The converter follows the XML structures in SmartBear's
[published sample projects](https://github.com/SmartBear/soapui-sample-projects)
and the official
[property expansion documentation](https://www.soapui.org/docs/scripting-and-properties/property-expansion/).
The committed mixed REST/SOAP fixture is synthetic. CDATA body text, Unicode,
whitespace and XML entities are preserved as request text.

## Credentials and unsupported behavior

Recognized auth fields, secret properties, sensitive headers/parameters and
password/token fields in JSON/XML payloads become secret variables. Their values
are blank by default. Explicitly enable **Include recognized authentication and
secret values** to retain those values. Preview responses contain metadata only,
even with credential inclusion enabled. Secret variables remain subject to
Postbox's normal masking and export controls.

Heuristics cannot recognize every secret embedded in arbitrary text, URLs or
payloads. Review the source and imported requests before sharing them. Inline
credentials in endpoint URLs are omitted by default and reported.

Source assertions and scripts are never converted into passing Postbox tests or
executed during migration. Groovy, property transfers, data sources, disabled
steps, mocks, load/security tests, attachments, WS-Security, WS-Addressing,
reliable messaging, external auth profiles and unsupported parameter styles
produce diagnostics. Cached WSDL definitions are not used to synthesize requests
or fetched from the network. The import preserves saved request snapshots;
source test-run orchestration is not equivalent to a Postbox collection run.

Supported `${#Project#name}`, `${#TestSuite#name}`, `${#TestCase#name}` and
Properties TestStep references become `{{variables}}`. Missing, environment,
system, XPath and dynamic Groovy expansions remain visible with diagnostics;
the server never reads its own environment or evaluates expressions to fill them.
Recreate required assertions and workflows in Postbox before relying on results.

## REST and MCP

Use the authenticated `POST /api/import` endpoint with `workspaceId` and either
`content` (XML text) or `url` (an explicit project URL). Link fetches use the normal
outbound host policy. `includeCredentials` is optional and defaults to omission
for SoapUI. `preview: true` returns HTTP 200 metadata without writing data;
omitting it imports a collection and returns HTTP 201.

```json
{
  "workspaceId": "workspace-id",
  "content": "<soapui-project name=\"Example\">...</soapui-project>",
  "includeCredentials": false,
  "preview": true
}
```

MCP's `import_spec` tool accepts the same XML content/URL, credential flag and
preview flag. Preview returns `kind: "preview"`; persistence returns
`kind: "collection", source: "soapui"`. Both include `sourceCounts`, structured
`diagnostics` (`code`, `path`, `message`) and human-readable `warnings`.

Source counts distinguish saved definitions and request test steps from converted
and skipped requests, and count unsupported test steps, assertions, scripts,
attachments and properties. The golden fixture verifies the accounting equation
`requestDefinitions + requestTestSteps = convertedRequests + skippedRequests`.
Counts describe source snapshots and migration outcomes, not passing tests.

XML is validated and bounded to 10 MB, 64 nesting levels, 50,000 elements and
10,000 converted requests. DTDs and custom entities are rejected. Diagnostics are
capped at 500 entries with an explicit truncation notice. Parsing and preview do
not fetch external definitions, load local files or execute source code. Invalid
input is rejected before collection persistence; successful persistence uses the
existing transactional collection importer.
