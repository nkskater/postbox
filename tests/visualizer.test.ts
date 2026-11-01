import { TABLE_VISUALIZER_EXAMPLE, CHART_VISUALIZER_EXAMPLE } from "@/core/visualizer/examples";
import { describe, expect, it } from "vitest";
import { renderVisualization, inertVisualization } from "@/core/visualizer/render";
import { runScript } from "@/core/scripts/sandbox";
import { emptyScopes } from "@/core/variables/resolver";
const context = {
  scopes: emptyScopes(),
  request: { url: "https://example.test", method: "GET", headers: [] },
  info: {
    eventName: "test" as const,
    iteration: 0,
    iterationCount: 1,
    requestName: "Test",
    requestId: "test",
  },
};
describe("isolated response visualizations", () => {
  it("runs both editor examples against response data", async () => {
    for (const code of [
      TABLE_VISUALIZER_EXAMPLE,
      CHART_VISUALIZER_EXAMPLE,
      TABLE_VISUALIZER_EXAMPLE + "\n" + CHART_VISUALIZER_EXAMPLE,
    ]) {
      const result = await runScript(code, {
        ...context,
        response: {
          code: 200,
          status: "OK",
          headers: [],
          body: '{"cats":3,"dogs":5}',
          responseTime: 1,
          responseSize: 19,
        },
      });
      expect(result.error).toBeUndefined();
      const view = await renderVisualization(result.visualization!);
      expect(view.error).toBeUndefined();
      expect(view.html).toContain("cats");
      expect(view.html).not.toContain("<script");
    }
  });
  it("bridges set/get/clear and preserves data between script phases", async () => {
    const first = await runScript(
      'pm.visualizer.set("<p>{{name}}</p>",{name:"Alice"}); pm.test("get",()=>pm.expect(pm.visualizer.get().data.name).to.equal("Alice"));',
      context,
    );
    expect(first.error).toBeUndefined();
    expect(first.visualizationSet).toBe(true);
    expect(first.tests[0].passed).toBe(true);
    const second = await runScript(
      'pm.test("same",()=>pm.expect(pm.visualizer.get().data.name).to.equal("Alice"));pm.visualizer.clear();',
      { ...context, visualization: first.visualization },
    );
    expect(second.tests[0].passed).toBe(true);
    expect(second.visualization).toBeNull();
    expect(second.visualizationSet).toBe(true);
  });
  it("renders escaped table templates and inline SVG chart scripts with pm.getData", async () => {
    const table = await renderVisualization({
      template: "<table>{{#each rows}}<tr><td>{{name}}</td></tr>{{/each}}</table>",
      data: { rows: [{ name: "Alice <script>bad()</script>" }] },
    });
    expect(table.error).toBeUndefined();
    expect(table.html).toContain("&lt;script&gt;");
    expect(table.html).toContain("<table>");
    const chart = await renderVisualization({
      template:
        '<svg id="chart"></svg><script>pm.getData(function(error,data){var rect=document.createElementNS("http://www.w3.org/2000/svg","rect");rect.setAttribute("width",data.value);rect.setAttribute("height","20");document.getElementById("chart").appendChild(rect);});</script>',
      data: { value: 42 },
    });
    expect(chart.error).toBeUndefined();
    expect(chart.html).toContain('width="42"');
    expect(chart.html).not.toContain("<script>");
  });
  it("prevents browser script, network, navigation and dangerous SVG output", async () => {
    const result = await renderVisualization({
      template:
        '<meta http-equiv="refresh" content="0;url=https://evil.test"><a href="https://evil.test" onclick="alert(1)">link</a><iframe src="https://evil.test"></iframe><svg><animate attributeName="href" to="https://evil.test"/><foreignObject><form action="https://evil.test">bad</form></foreignObject></svg><img src="https://evil.test"><script>document.body.setAttribute("onload","bad()");</script>',
    });
    expect(result.error).toBeUndefined();
    expect(result.html).not.toMatch(
      /evil\.test|onclick|onload|<iframe|<form|<animate|<foreignObject|<script/,
    );
    expect(result.html).toContain("script-src 'none'");
    expect(result.html).toContain("form-action 'none'");
    expect(
      (await renderVisualization({ template: '<script>fetch("https://evil.test")</script>' })).error,
    ).toBeTruthy();
    expect(
      (await renderVisualization({ template: '<script src="https://evil.test"></script>' })).error,
    ).toMatch(/External/);
  });
  it("bounds loops, memory and output and isolates repeated renders", async () => {
    expect((await renderVisualization({ template: "<script>while(true){}</script>" })).error).toBeTruthy();
    const first = await renderVisualization({
      template: '<script>globalThis.persisted="old";</script><p>first</p>',
    });
    expect(first.error).toBeUndefined();
    const second = await renderVisualization({
      template:
        '<p id="value"></p><script>document.getElementById("value").textContent=typeof persisted;</script>',
    });
    expect(second.html).toContain("undefined");
    expect(() => inertVisualization("x".repeat(513 * 1024))).toThrow(/512/);
    expect((await renderVisualization({ template: "x".repeat(129 * 1024) })).error).toBeTruthy();
  });
  it("redacts literal and derived secret values from data, templates, output and errors", async () => {
    const secret = "visualizer-private-value";
    const rendered = await renderVisualization(
      {
        template: '<p>{{value}}</p><script>document.body.append("visualizer-"+"private-value");</script>',
        data: { value: secret },
      },
      [secret],
    );
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).not.toContain(secret);
    const failed = await renderVisualization(
      { template: '<script>throw new Error("visualizer-"+"private-value")</script>' },
      [secret],
    );
    expect(failed.error).not.toContain(secret);
  });
});
