import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ALAYA_SYSEXITS,
  DuplicateSubcommandError,
  type AlayaCliArgsSchema,
  type AlayaCliDaemonRuntime,
  createAlayaCliBridge,
  type AlayaCliResult
} from "../cli/bridge.js";
// @ts-expect-error bin/alaya.mjs is plain JS with no .d.ts; typed via usage here.
import { createAlayaCliModuleLoaders, loadAlayaCliModules, runAlayaCli } from "../../../../bin/alaya.mjs";

function createTextSink(): { readonly stream: PassThrough; readonly readText: () => string } {
  const stream = new PassThrough();
  let content = "";
  stream.on("data", (chunk) => {
    content += chunk.toString("utf8");
  });
  return {
    stream,
    readText: () => content
  };
}

function createBridgeHarness(params: {
  readonly startupSteps?: readonly { readonly step: string }[];
  readonly env?: NodeJS.ProcessEnv;
  readonly isDaemonReady?: (daemon: { readonly startupSteps: readonly { readonly step: string }[] }) => boolean;
} = {}) {
  const stdout = createTextSink();
  const stderr = createTextSink();
  const daemon = {
    startupSteps: params.startupSteps ?? [{ step: "http-app" }]
  };

  const bridge = createAlayaCliBridge(daemon as unknown as AlayaCliDaemonRuntime, {
    cwd: "/tmp/alaya",
    env: params.env ?? {},
    stdin: new PassThrough(),
    stdout: stdout.stream,
    stderr: stderr.stream,
    isTTY: false,
    isDaemonReady: params.isDaemonReady
  });

  return { bridge, stdout, stderr };
}

function stringArraySchema(): AlayaCliArgsSchema<string[]> {
  return {
    safeParse: (input) => {
      if (Array.isArray(input) && input.every((item) => typeof item === "string")) {
        return { success: true, data: input };
      }
      return {
        success: false,
        error: { issues: [{ path: [], message: "Expected string array." }] }
      };
    }
  };
}

function tupleLiteralSchema(expected: string): AlayaCliArgsSchema<readonly [string]> {
  return {
    safeParse: (input) => {
      if (Array.isArray(input) && input.length === 1 && input[0] === expected) {
        return { success: true, data: [expected] as const };
      }
      return {
        success: false,
        error: { issues: [{ path: [0], message: `Expected ${expected}.` }] }
      };
    }
  };
}

function tupleStringSchema(): AlayaCliArgsSchema<readonly [string]> {
  return {
    safeParse: (input) => {
      if (Array.isArray(input) && input.length === 1 && typeof input[0] === "string") {
        return { success: true, data: [input[0]] as const };
      }
      return {
        success: false,
        error: { issues: [{ path: [0], message: "Expected one argument." }] }
      };
    }
  };
}

describe("cli bridge", () => {
  it("register rejects duplicate name", () => {
    const { bridge } = createBridgeHarness();
    const spec = {
      name: "doctor",
      description: "doctor command",
      argsSchema: stringArraySchema(),
      requiresDaemonReady: false,
      handler: async (): Promise<AlayaCliResult> => ({ exitCode: ALAYA_SYSEXITS.OK })
    };

    bridge.registerSubcommand(spec);
    expect(() => bridge.registerSubcommand(spec)).toThrowError(DuplicateSubcommandError);
  });

  it("unknown subcommand returns 64", async () => {
    const { bridge, stderr } = createBridgeHarness();
    bridge.registerSubcommand({
      name: "doctor",
      description: "doctor command",
      argsSchema: stringArraySchema(),
      requiresDaemonReady: false,
      handler: async (): Promise<AlayaCliResult> => ({ exitCode: ALAYA_SYSEXITS.OK })
    });

    const result = await bridge.dispatch(["missing"]);
    expect(result).toEqual({ exitCode: ALAYA_SYSEXITS.USAGE });
    expect(stderr.readText()).toContain("Unknown subcommand: missing");
    expect(stderr.readText()).toContain("Usage: alaya <subcommand> [args]");
  });

  it("missing subcommand returns 64", async () => {
    const { bridge, stderr } = createBridgeHarness();
    const result = await bridge.dispatch([]);

    expect(result).toEqual({ exitCode: ALAYA_SYSEXITS.USAGE });
    expect(stderr.readText()).toContain("Usage: alaya <subcommand> [args]");
  });

  it("args validation returns 64 on failure", async () => {
    const { bridge, stderr } = createBridgeHarness();
    bridge.registerSubcommand({
      name: "doctor",
      description: "doctor command",
      argsSchema: tupleLiteralSchema("--ok"),
      requiresDaemonReady: false,
      handler: async (): Promise<AlayaCliResult> => ({ exitCode: ALAYA_SYSEXITS.OK })
    });

    const result = await bridge.dispatch(["doctor", "--bad"]);
    expect(result).toEqual({ exitCode: ALAYA_SYSEXITS.USAGE });
    expect(stderr.readText()).toContain("Invalid arguments for doctor:");
  });

  it("--json flag round-trips json result", async () => {
    const { bridge, stdout } = createBridgeHarness();
    bridge.registerSubcommand({
      name: "doctor",
      description: "doctor command",
      argsSchema: tupleStringSchema(),
      requiresDaemonReady: false,
      handler: async (_ctx, args): Promise<AlayaCliResult> => ({
        exitCode: ALAYA_SYSEXITS.OK,
        json: { token: args[0], ok: true }
      })
    });

    const result = await bridge.dispatch(["doctor", "--json", "alpha"]);
    expect(result).toEqual({
      exitCode: ALAYA_SYSEXITS.OK,
      json: { token: "alpha", ok: true }
    });
    expect(stdout.readText()).toBe("{\"token\":\"alpha\",\"ok\":true}\n");
  });

  it("--help short-circuits", async () => {
    const { bridge, stdout } = createBridgeHarness();
    const handler = vi.fn(async (): Promise<AlayaCliResult> => ({ exitCode: ALAYA_SYSEXITS.OK }));
    bridge.registerSubcommand({
      name: "doctor",
      description: "doctor command",
      argsSchema: stringArraySchema(),
      requiresDaemonReady: false,
      handler
    });

    const result = await bridge.dispatch(["doctor", "--help"]);
    expect(result).toEqual({ exitCode: ALAYA_SYSEXITS.OK });
    expect(handler).not.toHaveBeenCalled();
    expect(stdout.readText()).toContain("Usage: alaya doctor [args]");
  });

  it("pre-ready dispatch fails closed with 75", async () => {
    const { bridge, stderr } = createBridgeHarness({
      startupSteps: [{ step: "database" }]
    });
    const handler = vi.fn(async (): Promise<AlayaCliResult> => ({ exitCode: ALAYA_SYSEXITS.OK }));
    bridge.registerSubcommand({
      name: "doctor",
      description: "doctor command",
      argsSchema: stringArraySchema(),
      requiresDaemonReady: true,
      handler
    });

    const result = await bridge.dispatch(["doctor"]);
    expect(result).toEqual({ exitCode: ALAYA_SYSEXITS.TEMPFAIL });
    expect(handler).not.toHaveBeenCalled();
    expect(stderr.readText()).toContain("daemon not ready");
  });

  it("handler exception caught and sanitized", async () => {
    const { bridge, stderr } = createBridgeHarness({
      env: {}
    });
    bridge.registerSubcommand({
      name: "doctor",
      description: "doctor command",
      argsSchema: stringArraySchema(),
      requiresDaemonReady: false,
      handler: async (): Promise<AlayaCliResult> => {
        throw new Error("boom");
      }
    });

    const result = await bridge.dispatch(["doctor"]);
    expect(result).toEqual({ exitCode: ALAYA_SYSEXITS.SOFTWARE });
    const message = stderr.readText();
    expect(message).toContain("boom");
    expect(message).not.toContain("\n    at ");
  });

  it("handler exception includes stack when ALAYA_DEBUG is enabled", async () => {
    const { bridge, stderr } = createBridgeHarness({
      env: { ALAYA_DEBUG: "1" }
    });
    bridge.registerSubcommand({
      name: "doctor",
      description: "doctor command",
      argsSchema: stringArraySchema(),
      requiresDaemonReady: false,
      handler: async (): Promise<AlayaCliResult> => {
        throw new Error("debug boom");
      }
    });

    const result = await bridge.dispatch(["doctor"]);
    expect(result).toEqual({ exitCode: ALAYA_SYSEXITS.SOFTWARE });
    const message = stderr.readText();
    expect(message).toContain("Error: debug boom");
    expect(message).toContain("at ");
  });

  it("binary delegates to bridge cleanly", async () => {
    const stdout = createTextSink();
    const stderr = createTextSink();
    const dispatch = vi.fn(async (): Promise<AlayaCliResult> => ({ exitCode: 73 }));
    const registerSubcommand = vi.fn();
    const shutdown = vi.fn(async () => {});
    const runtime = {
      startupSteps: [{ step: "http-app" }],
      shutdown
    };
    const createAlayaDaemonRuntime = vi.fn(async () => runtime);
    const createAlayaCliBridge = vi.fn(() => ({
      registerSubcommand,
      dispatch,
      list: () => []
    }));
    const registerAlayaCliCommands = vi.fn();
    const loadModules = vi.fn(async () => ({
      createAlayaDaemonRuntime,
      createAlayaCliBridge,
      registerAlayaCliCommands,
      softwareExit: ALAYA_SYSEXITS.SOFTWARE
    }));

    const exitCode = await runAlayaCli(["doctor", "--json"], {
      cwd: "/tmp/alaya",
      env: {},
      stdin: new PassThrough(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTTY: false,
      loadModules
    });

    expect(exitCode).toBe(73);
    expect(dispatch).toHaveBeenCalledWith(["doctor", "--json"]);
    expect(createAlayaCliBridge).toHaveBeenCalledTimes(1);
    expect(registerAlayaCliCommands).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(stderr.readText()).toBe("");
  });

  it("binary module loader binds imports to the fixed CLI dist modules", async () => {
    const importedPaths: string[] = [];
    const loaded = await loadAlayaCliModules(createAlayaCliModuleLoaders(async (modulePath: string) => {
      importedPaths.push(modulePath.split("\\").join("/"));
      if (modulePath.endsWith("/cli/bridge.js")) {
        return {
          ALAYA_SYSEXITS: { SOFTWARE: ALAYA_SYSEXITS.SOFTWARE },
          createAlayaCliBridge: vi.fn()
        };
      }
      if (modulePath.endsWith("/cli/register.js")) {
        return { registerAlayaCliCommands: vi.fn() };
      }
      if (modulePath.endsWith("/index.js")) {
        return { createAlayaDaemonRuntime: vi.fn() };
      }
      throw new Error(`unexpected import path: ${modulePath}`);
    }));

    expect(importedPaths).toEqual([
      expect.stringMatching(/\/apps\/core-daemon\/dist\/cli\/bridge\.js$/u),
      expect.stringMatching(/\/apps\/core-daemon\/dist\/cli\/register\.js$/u),
      expect.stringMatching(/\/apps\/core-daemon\/dist\/index\.js$/u)
    ]);
    expect(loaded.softwareExit).toBe(ALAYA_SYSEXITS.SOFTWARE);
  });

  it("list preserves registration order", () => {
    const { bridge } = createBridgeHarness();
    bridge.registerSubcommand({
      name: "doctor",
      description: "doctor command",
      argsSchema: stringArraySchema(),
      requiresDaemonReady: false,
      handler: async (): Promise<AlayaCliResult> => ({ exitCode: ALAYA_SYSEXITS.OK })
    });
    bridge.registerSubcommand({
      name: "tools",
      description: "tools command",
      argsSchema: stringArraySchema(),
      requiresDaemonReady: false,
      handler: async (): Promise<AlayaCliResult> => ({ exitCode: ALAYA_SYSEXITS.OK })
    });
    bridge.registerSubcommand({
      name: "status",
      description: "status command",
      argsSchema: stringArraySchema(),
      requiresDaemonReady: false,
      handler: async (): Promise<AlayaCliResult> => ({ exitCode: ALAYA_SYSEXITS.OK })
    });

    expect(bridge.list()).toEqual([
      { name: "doctor", description: "doctor command" },
      { name: "tools", description: "tools command" },
      { name: "status", description: "status command" }
    ]);
  });
});
