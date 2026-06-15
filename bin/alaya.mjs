#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const bridgeDistPath = resolve(repoRoot, "apps/core-daemon/dist/cli/bridge.js");
const registerDistPath = resolve(repoRoot, "apps/core-daemon/dist/cli/register.js");
const daemonDistPath = resolve(repoRoot, "apps/core-daemon/dist/index.js");
const SOFTWARE_EXIT_FALLBACK = 70;

export function createAlayaCliModuleLoaders(importModule = defaultImportModule) {
  return Object.freeze({
    bridge: () => importModule(bridgeDistPath),
    register: () => importModule(registerDistPath),
    daemon: () => importModule(daemonDistPath)
  });
}

export async function loadAlayaCliModules(loaders = createAlayaCliModuleLoaders()) {
  const moduleLoaders = typeof loaders === "function"
    ? createAlayaCliModuleLoaders(loaders)
    : loaders;
  const [bridgeModule, registerModule, daemonModule] = await Promise.all([
    moduleLoaders.bridge(),
    moduleLoaders.register(),
    moduleLoaders.daemon()
  ]);

  if (typeof bridgeModule.createAlayaCliBridge !== "function") {
    throw new Error(`Cannot find module "${bridgeDistPath}". Run \`rtk pnpm build\` first.`);
  }
  if (typeof daemonModule.createAlayaDaemonRuntime !== "function") {
    throw new Error(`Cannot find module "${daemonDistPath}". Run \`rtk pnpm build\` first.`);
  }
  if (typeof registerModule.registerAlayaCliCommands !== "function") {
    throw new Error(`Cannot find module "${registerDistPath}". Run \`rtk pnpm build\` first.`);
  }

  const softwareExit = toExitCode(bridgeModule.ALAYA_SYSEXITS?.SOFTWARE, SOFTWARE_EXIT_FALLBACK);

  return {
    createAlayaCliBridge: bridgeModule.createAlayaCliBridge,
    registerAlayaCliCommands: registerModule.registerAlayaCliCommands,
    createAlayaDaemonRuntime: daemonModule.createAlayaDaemonRuntime,
    softwareExit
  };
}

export async function runAlayaCli(
  argv = process.argv.slice(2),
  options = {}
) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const isTTY = options.isTTY ?? Boolean(stdout.isTTY);
  const loadModules = options.loadModules ?? loadAlayaCliModules;

  let softwareExit = SOFTWARE_EXIT_FALLBACK;
  let runtime = null;

  try {
    const loaded = await loadModules();
    softwareExit = loaded.softwareExit;
    runtime = await loaded.createAlayaDaemonRuntime();
    const bridge = loaded.createAlayaCliBridge(runtime, {
      cwd,
      env,
      stdin,
      stdout,
      stderr,
      isTTY
    });
    loaded.registerAlayaCliCommands(bridge, runtime);
    const result = await bridge.dispatch(argv);
    return toExitCode(result?.exitCode, softwareExit);
  } catch (error) {
    writeError(stderr, error, env);
    return softwareExit;
  } finally {
    if (runtime !== null && typeof runtime.shutdown === "function") {
      try {
        await runtime.shutdown();
      } catch (shutdownError) {
        writeError(stderr, shutdownError, env);
      }
    }
  }
}

async function defaultImportModule(path) {
  return await import(pathToFileURL(path).href);
}

function toExitCode(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function writeError(stream, error, env) {
  const debugEnabled = env.ALAYA_DEBUG === "1";
  if (debugEnabled && error instanceof Error && typeof error.stack === "string") {
    stream.write(`${error.stack}\n`);
    return;
  }

  if (error instanceof Error) {
    const message = error.message.trim();
    stream.write(`${message.length > 0 ? message : "CLI bridge failed."}\n`);
    return;
  }

  stream.write("CLI bridge failed.\n");
}

function isDirectExecution() {
  if (process.argv[1] === undefined) {
    return false;
  }
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
}

if (isDirectExecution()) {
  const exitCode = await runAlayaCli();
  // invariant: flush stdout/stderr before exit. macOS pipe buffers are small and a bare
  // process.exit() drops un-drained output, truncating large --json payloads (e.g. the
  // 16-tool `tools list --json`). write("",cb) fires after the stream buffer flushes.
  let pending = 2;
  const finish = () => {
    pending -= 1;
    if (pending === 0) process.exit(exitCode);
  };
  process.stdout.write("", finish);
  process.stderr.write("", finish);
}
