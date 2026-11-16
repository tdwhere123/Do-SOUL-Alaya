import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const DEFAULT_BRIDGE = `export const ALAYA_SYSEXITS={SOFTWARE:70};
      export function createAlayaCliBridge(){return {dispatch:async()=>{process.stdout.write('command completed\\n'); return {exitCode:0};}};}`;
const SUCCESS_DAEMON =
  "export async function createAlayaDaemonRuntime(){return {shutdown:async()=>{}};}";
const LARGE_STDOUT = `${"O".repeat(100_000)}\n`;
const LARGE_STDERR = `${"E".repeat(100_000)}\n`;

function stageLauncherTree(daemonSource: string, bridgeSource = DEFAULT_BRIDGE) {
  const root = mkdtempSync(join(tmpdir(), "alaya-launcher-cleanup-"));
  try {
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
    write("package.json", '{"type":"module"}');
    const dist = "apps/core-daemon/dist";
    copy(new URL("../../../dist/cli/support/module-loader.js", import.meta.url), `${dist}/cli/support/module-loader.js`);
    for (const relative of ["cli/errors/error-reporting.js", "runtime/config/daemon-config-environment.js"]) {
      const target = join(root, dist, relative);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(fileURLToPath(new URL(`../../../dist/${relative}`, import.meta.url)), target);
    }
    write(`${dist}/cli/bridge.js`, bridgeSource);
    write(`${dist}/cli/register.js`, "export function registerAlayaCliCommands(){};");
    write(`${dist}/index.js`, daemonSource);
    copy(new URL("../../../../../bin/alaya.mjs", import.meta.url), "bin/alaya.mjs");
    copy(new URL("../../../bin/alaya.mjs", import.meta.url), "apps/core-daemon/bin/alaya.mjs");
    return {
      root,
      installed: join(root, "bin/alaya.mjs"),
      private: join(root, "apps/core-daemon/bin/alaya.mjs"),
      moduleLoader: join(root, dist, "cli/support/module-loader.js"),
      cleanup() {
        rmSync(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function runLauncher(
  launcher: "installed" | "private",
  command: string,
  daemonSource: string,
  bridgeSource = DEFAULT_BRIDGE
) {
  const tree = stageLauncherTree(daemonSource, bridgeSource);
  try {
    return spawnSync(process.execPath, [tree[launcher], command], { encoding: "utf8", timeout: 20_000 });
  } finally {
    tree.cleanup();
  }
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

it.each(["installed", "private"] as const)("%s launcher omits embedding startup probes for maintenance and health reporting", launcher => {
  const daemonSource = `export async function createAlayaDaemonRuntime(options){
    process.stdout.write('startup='+JSON.stringify(options ?? null)+'\\n');
    return {shutdown:async()=>{}};}`;
  const lexical = runLauncher(launcher, "source-index-lexical", daemonSource);
  expect(lexical.error).toBeUndefined();
  expect(lexical.status).toBe(0);
  expect(lexical.stdout).toBe('startup={"embeddingStartupProbe":"omit"}\ncommand completed\n');
  expect(lexical.stderr).toBe("");
  for (const command of ["doctor", "status", "--help"]) {
    const health = runLauncher(launcher, command, daemonSource);
    expect(health.error).toBeUndefined();
    expect(health.status).toBe(0);
    expect(health.stdout).toBe('startup={"embeddingStartupProbe":"omit"}\ncommand completed\n');
    expect(health.stderr).toBe("");
  }
  const ordinary = runLauncher(launcher, "tools", daemonSource);
  expect(ordinary.error).toBeUndefined();
  expect(ordinary.status).toBe(0);
  expect(ordinary.stdout).toBe("startup=null\ncommand completed\n");
  expect(ordinary.stderr).toBe("");
}, 60_000);

it.each(["installed", "private"] as const)("%s launcher drains complete large stdout and stderr before exit", launcher => {
  const result = runLauncher(
    launcher,
    "doctor",
    SUCCESS_DAEMON,
    `export const ALAYA_SYSEXITS={SOFTWARE:70};
      export function createAlayaCliBridge(){return {dispatch:async()=>{
        process.stdout.write(${JSON.stringify(LARGE_STDOUT)});
        process.stderr.write(${JSON.stringify(LARGE_STDERR)});
        return {exitCode:0};
      }};}`
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(LARGE_STDOUT);
  expect(result.stderr).toBe(LARGE_STDERR);
}, 30_000);

it.each(["installed", "private"] as const)("%s launcher import does not start the CLI process", launcher => {
  const tree = stageLauncherTree(
    "export async function createAlayaDaemonRuntime(){process.stdout.write('runtime-started\\n');return {shutdown:async()=>{}};}"
  );
  try {
    const importer = join(tree.root, "import-launcher.mjs");
    const specifier = pathToFileURL(tree[launcher]).href;
    writeFileSync(
      importer,
      `import {
  createAlayaCliModuleLoaders,
  loadAlayaCliModules,
  runAlayaCli,
  SOFTWARE_EXIT_FALLBACK,
  resolveAlayaCliDistPaths
} from ${JSON.stringify(specifier)};
const helpers = [createAlayaCliModuleLoaders, loadAlayaCliModules, runAlayaCli, resolveAlayaCliDistPaths];
if (helpers.some((value) => typeof value !== "function") || SOFTWARE_EXIT_FALLBACK !== 70) {
  throw new Error("stable launcher helpers missing");
}
process.stdout.write("imported\\n");
`
    );
    const result = spawnSync(process.execPath, [importer], { encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("imported\n");
    expect(result.stderr).toBe("");
  } finally {
    tree.cleanup();
  }
}, 30_000);

it("built module-loader does not start the CLI when executed as the process entry", () => {
  const tree = stageLauncherTree(
    "export async function createAlayaDaemonRuntime(){process.stdout.write('runtime-started\\n');return {shutdown:async()=>{}};}"
  );
  try {
    const result = spawnSync(process.execPath, [tree.moduleLoader], { encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  } finally {
    tree.cleanup();
  }
}, 30_000);
