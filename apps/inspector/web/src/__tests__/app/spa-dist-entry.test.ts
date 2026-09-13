import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = fs.existsSync(path.join(process.cwd(), "apps/inspector/web/package.json"))
  ? path.resolve(process.cwd(), "apps/inspector/web")
  : process.cwd();
const distHtml = path.join(webRoot, "dist", "index.html");

describe("inspector SPA production entry", () => {
  it("evaluates the built dist entry without throwing", () => {
    expect(fs.existsSync(distHtml), "apps/inspector/web/dist must be built").toBe(true);
    const html = fs.readFileSync(distHtml, "utf8");
    const scriptSrc = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
    expect(scriptSrc, "dist index.html must reference the entry chunk").toBeDefined();
    const entry = path.join(webRoot, "dist", scriptSrc!.slice(1));
    expect(fs.existsSync(entry)).toBe(true);

    const require = createRequire(path.join(webRoot, "package.json"));
    const jsdomHref = pathToFileURL(require.resolve("jsdom")).href;
    const entryHref = pathToFileURL(entry).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", loadScript(jsdomHref, entryHref)], {
      encoding: "utf8",
      cwd: webRoot,
      timeout: 30_000
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `SPA entry load failed with status ${result.status}`);
    }
    expect(result.stdout).toContain("SPA_ENTRY_OK");
  });
});

function loadScript(jsdomHref: string, entryHref: string): string {
  return `
    import { JSDOM } from ${JSON.stringify(jsdomHref)};
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "http://127.0.0.1/",
      pretendToBeVisual: true
    });
    const g = globalThis;
    const install = (name, value) => {
      try { Object.defineProperty(g, name, { configurable: true, writable: true, value }); }
      catch { /* Node 24 web globals are sometimes getter-only. */ }
    };
    for (const key of Object.getOwnPropertyNames(dom.window)) {
      if (key in g) continue;
      try { install(key, dom.window[key]); } catch {}
    }
    install("window", dom.window);
    install("document", dom.window.document);
    install("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    install("matchMedia", () => ({
      matches: false, media: "", onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; }
    }));
    install("fetch", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    try {
      await import(${JSON.stringify(entryHref)});
      if (document.getElementById("root") === null) throw new Error("missing #root");
      process.stdout.write("SPA_ENTRY_OK\\n");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      process.stderr.write("SPA_ENTRY_LOAD_ERROR: " + err.name + " | " + err.message + "\\n");
      process.exit(1);
    }
  `;
}
