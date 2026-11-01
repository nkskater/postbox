import Handlebars from "handlebars";
import { parseHTML } from "linkedom";
// This bundle is evaluated only in a fresh QuickJS runtime with no host capabilities.
globalThis.__renderVisualization = function (input) {
  const html = Handlebars.compile(input.template, {
    noEscape: input.options?.noEscape === true,
    strict: input.options?.strict === true,
  })(input.data ?? {});
  const { document, window } = parseHTML(
    "<!doctype html><html><head></head><body>" + html + "</body></html>",
  );
  const serialize = () => document.documentElement.outerHTML;
  const scripts = Array.from(document.querySelectorAll("script"));
  globalThis.document = document;
  globalThis.window = window;
  globalThis.pm = Object.freeze({
    getData: (callback) => {
      if (typeof callback !== "function") throw new Error("pm.getData expects a callback");
      callback(null, input.data ?? {});
    },
  });
  for (const script of scripts) {
    if (script.hasAttribute("src"))
      throw new Error("External visualization scripts are disabled; use inline code and SVG");
    const code = script.textContent;
    script.remove();
    if (code.trim()) (0, eval)(code);
  }
  return serialize();
};
