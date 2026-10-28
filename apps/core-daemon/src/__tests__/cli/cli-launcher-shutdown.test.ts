import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

function runLauncher(launcher: "installed" | "private", command: string, daemonSource: string) {
  const root = mkdtempSync(join(tmpdir(), "alaya-launcher-cleanup-"));
  const write = (relative: string, content: string) => {
    const filename = join(root, relative);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  };
  const copy = (source: URL, relative: string) => {
    const filename = join(root, relative);
    mkdirSync(dirname(filename), { recursive: true });
    copyFileSync(fileURLToPath(source), filename);
  };
  try {
    write("package.json", '{"type":"module"}');
    const dist = "apps/core-daemon/dist";
    copy(new URL("../../../dist/cli/support/module-loader.js", import.meta.url), `${dist}/cli/support/module-loader.js`);
    for (const relative of ["cli/errors/error-reporting.js", "runtime/config/daemon-config-environment.js"]) {
      const target = join(root, dist, relative);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(fileURLToPath(new URL(`../../../dist/${relative}`, import.meta.url)), target);
    }
    write(`${dist}/cli/bridge.js`, `export const ALAYA_SYSEXITS={SOFTWARE:70};
      export function createAlayaCliBridge(){return {dispatch:async()=>{process.stdout.write('command completed\\n'); return {exitCode:0};}};}`);
    write(`${dist}/cli/register.js`, "export function registerAlayaCliCommands(){};");
    write(`${dist}/index.js`, daemonSource);
    const relative = launcher === "installed" ? "bin/alaya.mjs" : "apps/core-daemon/bin/alaya.mjs";
    copy(new URL(launcher === "installed" ? "../../../../../bin/alaya.mjs" : "../../../bin/alaya.mjs", import.meta.url), relative);
    return spawnSync(process.execPath, [join(root, relative), command], { encoding: "utf8", timeout: 20_000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it.each(["installed", "private"] as const)("%s launcher exits unsuccessfully when completed command cleanup fails", launcher => {
  const result = runLauncher(launcher, "doctor",
    "export async function createAlayaDaemonRuntime(){return {shutdown:async()=>{throw new Error('fixture-private-cleanup-error');}};}");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(70);
  expect(result.stdout).toBe("command completed\n");
  expect(result.stderr).toContain("category=shutdown");
  expect(result.stderr).not.toContain("fixture-private-cleanup-error");
}, 30_000);

it.each(["installed", "private"] as const)("%s launcher omits embedding startup effects only for lexical maintenance", launcher => {
  const daemonSource = `export async function createAlayaDaemonRuntime(options){
    process.stdout.write('startup='+JSON.stringify(options ?? null)+'\\n');
    return {shutdown:async()=>{}};}`;
  const lexical = runLauncher(launcher, "source-index-lexical", daemonSource);
  expect(lexical.error).toBeUndefined();
  expect(lexical.status).toBe(0);
  expect(lexical.stdout).toBe('startup={"embeddingStartupProbe":"omit"}\ncommand completed\n');
  expect(lexical.stderr).toBe("");
  const ordinary = runLauncher(launcher, "doctor", daemonSource);
  expect(ordinary.error).toBeUndefined();
  expect(ordinary.status).toBe(0);
  expect(ordinary.stdout).toBe("startup=null\ncommand completed\n");
  expect(ordinary.stderr).toBe("");
}, 60_000);
