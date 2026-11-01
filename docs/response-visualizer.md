# Response visualizations

Use the request's **Post-response Script** editor to insert **Visualize as a
table** or **Visualize as a bar chart** from the snippets list. Send the request,
then open **Visualization** in the response panel. Both examples expect JSON;
object properties become name/value rows, or supply an array of `{name,value}`.
The chart uses inline SVG and needs no downloaded library.

```js
pm.visualizer.set("<table>{{#each rows}}<tr><td>{{name}}</td><td>{{value}}</td></tr>{{/each}}</table>", {
  rows: [
    { name: "Cats", value: 3 },
    { name: "Dogs", value: 5 },
  ],
});
```

`pm.visualizer.set(template, data?, options?)` accepts a Handlebars HTML template,
JSON data (default `{}`), and the supported `strict` / `noEscape` compile options.
Normal interpolations escape HTML. `pm.visualizer.get()` returns a copy of the
current `{template,data,options}` or `null`; `pm.visualizer.clear()` removes it.
Collection/folder/request pre- and post-response scripts share the latest
visualization for that send. The last set/clear wins. New sends start fresh.
Unknown compile options cannot enable prototype access or arbitrary helpers.

Inline template JavaScript can use `pm.getData(function(error,data) { ... })` and
the offline `document` DOM, including `createElementNS` for SVG. For example:

```js
pm.visualizer.set(
  `
  <svg id="chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 40"></svg>
  <script>
    pm.getData(function (error, data) {
      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bar.setAttribute('width', data.value);
      bar.setAttribute('height', '30');
      bar.setAttribute('fill', '#4f86c6');
      document.getElementById('chart').appendChild(bar);
    });
  </script>`,
  { value: 120 },
);
```

## Isolation and limits

Rendering is offline, inside a fresh QuickJS runtime with a one-second deadline,
64 MiB memory limit and bounded stack. Inline scripts run synchronously against a
DOM implementation; they have no browser window, storage, network, Node.js or
filesystem capabilities. External scripts, stylesheets and assets cannot load.
Browser-only libraries, canvas rendering, timers and ongoing browser interaction
are not supported; use inline SVG or HTML/CSS. Renderer failures appear in the
Visualization tab without suppressing the actual API response or test results.

Before output reaches the browser, active elements and URL/event attributes are
removed. The final document has a mandatory restrictive content security policy
and is displayed in an iframe with an empty sandbox permission set. Browser
scripts, forms, navigation, frames and network requests are blocked. Existing
response-body previews retain their own separate restrictions.

Template and data limits are 128 KiB and 256 KiB respectively; output is limited
to 512 KiB. Known secret variables, credentials and sensitive response fields are
redacted before rendering and again in decoded output text/attributes. Script
updates to declared secrets are covered. Do not deliberately encode secrets into
visualizations; arbitrary transformations cannot provide general taint tracking.
Visualization results are transient: they are not persisted in browser storage,
history, saved examples or collection-run reports. Saving a request persists its
script, so literal credentials should always be referenced through secret
variables instead of embedded in template source.

## Automation

`POST /api/proxy` returns sanitized `visualization` input and
`visualizationResult: {html,error?}` along with the normal response. MCP
`send_request` returns the same two fields. An HTML string is the already
sanitized static document; render it with an empty iframe sandbox if using it in
a custom UI. `error` reports bounded rendering failures. No additional route or
permission is required beyond the existing request-execution permissions.
