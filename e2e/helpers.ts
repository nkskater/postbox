import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

/** Chromium to drive: E2E_CHROMIUM, else a cached Playwright headless shell, else Playwright's own default. */
function executablePath(): string | undefined {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    const dir = fs.readdirSync(cache).find((d) => d.startsWith("chromium_headless_shell-"));
    if (dir) {
      const exe = path.join(cache, dir, "chrome-linux", "headless_shell");
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    /* use Playwright's default */
  }
  return undefined;
}

export const launch = (): Promise<Browser> => chromium.launch({ executablePath: executablePath() });

/** A page that records every uncaught exception and console error so a test can assert there were none. */
export async function openApp(browser: Browser, baseUrl: string) {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // The browser logs failed resource loads on its own; real failures show up as page errors or failed assertions.
    if (/Failed to load resource/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Console" }).waitFor();
  return { page, context, errors };
}

/** Type into a CodeMirror field. */
export async function typeInEditor(page: Page, placeholder: string, text: string) {
  const field = page.locator(".cm-content", { hasText: placeholder }).first();
  await field.click();
  await page.keyboard.type(text);
}
