import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AlayaCliBridge, AlayaCliBridgeOptions, AlayaCliResult } from "./bridge.js";
import type { AlayaDaemonRuntime } from "../index.js";
import { writeCliFailure } from "./errors/error-reporting.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..", "..", "..", "..");
const bridgeDistPath = resolve(repoRoot, "apps/core-daemon/dist/cli/bridge.js");
const registerDistPath = resolve(repoRoot, "apps/core-daemon/dist/cli/register.js");
const daemonDistPath = resolve(repoRoot, "apps/core-daemon/dist/index.js");
export const SOFTWARE_EXIT_FALLBACK = 70;

export interface LoadedAlayaCliModules {
  readonly createAlayaCliBridge: (
    runtime: AlayaDaemonRuntime,
    options: AlayaCliBridgeOptions
  ) => AlayaCliBridge;
  readonly registerAlayaCliCommands: (bridge: AlayaCliBridge, runtime: AlayaDaemonRuntime) => void;
  readonly createAlayaDaemonRuntime: () => Promise<AlayaDaemonRuntime>;
  readonly softwareExit: number;
}

export function createAlayaCliModuleLoaders(
  importModule: (modulePath: string) => Promise<unknown> = defaultImportModule
) {
  return Object.freeze({
    bridge: () => importModule(bridgeDistPath),
    register: () => importModule(registerDistPath),
    daemon: () => importModule(daemonDistPath)
  });
}

export async function loadAlayaCliModules(
  loaders: ReturnType<typeof createAlayaCliModuleLoaders> | ((modulePath: string) => Promise<unknown>) =
    createAlayaCliModuleLoaders()
): Promise<LoadedAlayaCliModules> {
  const moduleLoaders =
    typeof loaders === "function" ? createAlayaCliModuleLoaders(loaders) : loaders;
  const [bridgeModule, registerModule, daemonModule] = await Promise.all([
    moduleLoaders.bridge(),
    moduleLoaders.register(),
    moduleLoaders.daemon()
  ]) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];

  if (typeof bridgeModule.createAlayaCliBridge !== "function") {
    throw new Error(`Cannot find module "${bridgeDistPath}". Run \`rtk pnpm build\` first.`);
  }
  if (typeof daemonModule.createAlayaDaemonRuntime !== "function") {
    throw new Error(`Cannot find module "${daemonDistPath}". Run \`rtk pnpm build\` first.`);
  }
  if (typeof registerModule.registerAlayaCliCommands !== "function") {
    throw new Error(`Cannot find module "${registerDistPath}". Run \`rtk pnpm build\` first.`);
  }

  const softwareExit = toExitCode(
    (bridgeModule.ALAYA_SYSEXITS as { readonly SOFTWARE?: unknown } | undefined)?.SOFTWARE,
    SOFTWARE_EXIT_FALLBACK
  );

  return {
    createAlayaCliBridge: bridgeModule.createAlayaCliBridge as LoadedAlayaCliModules["createAlayaCliBridge"],
    registerAlayaCliCommands:
      registerModule.registerAlayaCliCommands as LoadedAlayaCliModules["registerAlayaCliCommands"],
    createAlayaDaemonRuntime:
      daemonModule.createAlayaDaemonRuntime as LoadedAlayaCliModules["createAlayaDaemonRuntime"],
    softwareExit
  };
}

async function defaultImportModule(modulePath: string): Promise<unknown> {
  return await import(pathToFileURL(modulePath).href);
}

function toExitCode(value: unknown, fallback: number): number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : fallback;
}

export function resolveAlayaCliDistPaths(): {
  readonly bridgeDistPath: string;
  readonly registerDistPath: string;
  readonly daemonDistPath: string;
} {
  return {
    bridgeDistPath,
    registerDistPath,
    daemonDistPath
  };
}

export interface RunAlayaCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
  readonly loadModules?: typeof loadAlayaCliModules;
}

export async function runAlayaCli(
  argv: readonly string[] = process.argv.slice(2),
  options: RunAlayaCliOptions = {}
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const isTTY = options.isTTY ?? Boolean((stdout as NodeJS.WriteStream).isTTY);
  const loadModules = options.loadModules ?? loadAlayaCliModules;

  let softwareExit = SOFTWARE_EXIT_FALLBACK;
  let runtime: AlayaDaemonRuntime | null = null;

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
    const result: AlayaCliResult | undefined = await bridge.dispatch([...argv]);
    return toExitCode(result?.exitCode, softwareExit);
  } catch (error) {
    writeCliFailure(stderr, error, "bootstrap");
    return softwareExit;
  } finally {
    if (runtime !== null && typeof runtime.shutdown === "function") {
      try {
        await runtime.shutdown();
      } catch (shutdownError) {
        writeCliFailure(stderr, shutdownError, "shutdown");
      }
    }
  }
}
