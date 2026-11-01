/** Offline template rendering: no guest code or executable links reach the browser. */
import { getQuickJS } from "quickjs-emscripten";
import { parseHTML } from "linkedom";
import { VISUALIZER_SOURCE } from "./runtime.generated";
import { VISUALIZER_LIMITS, visualizationSchema, type Visualization, type VisualizerResult } from "./model";
import { redactStoredValue, redactSecrets } from "../variables/resolver";
import { credentialRedactionValues, sensitiveFieldValues, redactSensitiveFields } from "../retention";
export const VISUALIZER_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
export function inertVisualization(html: string, secrets: Iterable<string> = []): string {
  const values = credentialRedactionValues(secrets);
  if (new TextEncoder().encode(html).byteLength > VISUALIZER_LIMITS.output)
    throw new Error("Visualization output exceeds 512 KiB");
  const { document } = parseHTML(html);
  for (const element of document.querySelectorAll(
    "script,iframe,frame,frameset,object,embed,link,meta,base,form,animate,animateMotion,animateTransform,set,foreignObject",
  ))
    element.remove();
  for (const element of document.querySelectorAll("*"))
    for (const attribute of Array.from(element.attributes)) {
      if (
        /^on/i.test(attribute.name) ||
        /^(?:href|src|srcset|action|formaction|poster|data|xlink:href|target|ping|download|autofocus|is)$/i.test(
          attribute.name,
        )
      )
        element.removeAttribute(attribute.name);
      else element.setAttribute(attribute.name, redactSecrets(attribute.value, values));
    }
  const walker = document.createTreeWalker(document, 4);
  let text;
  while ((text = walker.nextNode())) text.nodeValue = redactSecrets(text.nodeValue ?? "", values);
  const output = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${VISUALIZER_CSP}"><meta name="referrer" content="no-referrer"><style>body{font:14px system-ui;padding:12px;color:#222;background:white}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px;text-align:left}svg{max-width:100%}</style></head><body>${document.body?.innerHTML ?? ""}</body></html>`;
  if (new TextEncoder().encode(output).byteLength > VISUALIZER_LIMITS.output)
    throw new Error("Visualization output exceeds 512 KiB");
  return output;
}
export async function renderVisualization(
  raw: Visualization,
  secrets: Iterable<string> = [],
  signal?: AbortSignal,
): Promise<VisualizerResult> {
  const values = credentialRedactionValues([...secrets, ...sensitiveFieldValues(raw.data)]);
  let runtime: ReturnType<Awaited<ReturnType<typeof getQuickJS>>["newRuntime"]> | undefined;
  let vm: ReturnType<NonNullable<typeof runtime>["newContext"]> | undefined;
  try {
    const input = visualizationSchema.parse(redactStoredValue(redactSensitiveFields(raw), values));
    if (signal?.aborted) throw new Error("Visualization cancelled");
    runtime = (await getQuickJS()).newRuntime();
    runtime.setMemoryLimit(VISUALIZER_LIMITS.memoryBytes);
    runtime.setMaxStackSize(512 * 1024);
    const deadline = Date.now() + VISUALIZER_LIMITS.timeoutMs;
    runtime.setInterruptHandler(() => signal?.aborted === true || Date.now() > deadline);
    vm = runtime.newContext();
    const evaluate = (code: string) => {
      const result = vm!.evalCode(code, "visualizer.js");
      if (result.error) {
        const error = vm!.dump(result.error);
        result.error.dispose();
        throw new Error(error?.message ?? "Visualization failed");
      }
      return result.value;
    };
    evaluate(VISUALIZER_SOURCE).dispose();
    const result = evaluate(`__renderVisualization(${JSON.stringify(input)})`);
    let html: string;
    try {
      html = vm.getString(result);
    } finally {
      result.dispose();
    }
    html = redactSecrets(html, values);
    return { html: inertVisualization(html, values) };
  } catch (error) {
    return { html: "", error: redactSecrets((error as Error).message, values) };
  } finally {
    vm?.dispose();
    runtime?.dispose();
  }
}
