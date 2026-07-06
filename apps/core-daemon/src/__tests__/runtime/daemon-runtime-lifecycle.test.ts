import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonLifecycleControls } from "../../runtime/daemon-runtime-lifecycle.js";

type FakeSignalProcess = EventEmitter & {
  exitCode?: number | string | null;
  exit: ReturnType<typeof vi.fn>;
  emitSignal(signal: "SIGTERM" | "SIGINT"): void;
};

function createFakeSignalProcess(): FakeSignalProcess {
  const emitter = new EventEmitter() as FakeSignalProcess;
  emitter.exitCode = undefined;
  emitter.exit = vi.fn();
  emitter.emitSignal = (signal) => {
    emitter.emit(signal);
  };
  return emitter;
}

afterEach(() => {
  vi.useRealTimers();
});

function createControls(
  tokenSource: "env" | "ephemeral",
  overrides: Partial<{
    runBackgroundPass: () => Promise<void>;
    runBulkEnrichPass: (workspaceId: string) => Promise<void>;
    runEmbeddingBackfillPass: (workspaceId: string) => Promise<void>;
    recallReadWorkerClient: { close(): Promise<void> };
    database: { close(): void };
    backgroundManagerStop: () => Promise<void>;
    gardenBacklogTelemetryStop: () => Promise<unknown>;
    processPort: FakeSignalProcess;
    serverFactory: (...args: unknown[]) => {
      close(callback?: (error?: Error) => void): void;
      closeIdleConnections?(): void;
      closeAllConnections?(): void;
    };
  }> = {}
) {
  const warn = vi.fn();
  const runBackgroundPass =
    overrides.runBackgroundPass ?? vi.fn(async () => undefined);
  const runBulkEnrichPass =
    overrides.runBulkEnrichPass ?? vi.fn(async () => undefined);
  const runEmbeddingBackfillPass =
    overrides.runEmbeddingBackfillPass ?? vi.fn(async () => undefined);
  const lifecycleState = {
    drainState: { isDraining: false },
    inFlight: { count: 0 }
  };
  const backgroundManagerStop =
    overrides.backgroundManagerStop ?? vi.fn(async () => undefined);
  const gardenBacklogTelemetryStop =
    overrides.gardenBacklogTelemetryStop ?? vi.fn(async () => undefined);
  const controls = createDaemonLifecycleControls({
    app: { fetch: async () => new Response("ok") },
    lifecycleState,
    warnLogger: { warn },
    gardenBacklogTelemetryService: {
      start: vi.fn(),
      stop: gardenBacklogTelemetryStop
    },
    gardenRuntime: {
      backgroundManager: {
        start: vi.fn(),
        stop: backgroundManagerStop
      },
      setBacklogTelemetryObserver: vi.fn(),
      runBackgroundPass,
      runBulkEnrichPass,
      runEmbeddingBackfillPass
    },
    securityStatusService: { close: vi.fn() },
    daemonMcpRuntimeRegistry: { close: vi.fn(async () => undefined) },
    globalMemoryRecallInvalidationSubscription: null,
    recallReadWorkerClient: overrides.recallReadWorkerClient,
    database: overrides.database ?? { close: vi.fn() },
    requestProtection: {
      allowedOrigin: "http://localhost:5173",
      requestToken: "secret-token",
      tokenSource
    },
    processPort: overrides.processPort,
    serverFactory: overrides.serverFactory
  });

  return {
    controls,
    lifecycleState,
    warn,
    runBackgroundPass,
    runBulkEnrichPass,
    runEmbeddingBackfillPass,
    backgroundManagerStop,
    gardenBacklogTelemetryStop
  };
}

describe("createDaemonLifecycleControls", () => {
  it("fails closed for ephemeral request tokens unless explicitly allowed", async () => {
    const { controls } = createControls("ephemeral");

    await expect(controls.startHttpServer({ port: 0 })).rejects.toThrow(
      "ALAYA_REQUEST_TOKEN must be set before starting the daemon HTTP server"
    );
  });

  it("allows managed ephemeral request tokens when explicitly requested", async () => {
    const { controls, warn } = createControls("ephemeral");

    const server = await controls.startHttpServer({
      port: 0,
      allowEphemeralRequestToken: true
    });

    expect(server.port).toBeGreaterThanOrEqual(0);
    expect(warn).toHaveBeenCalledWith(
      "starting managed daemon with ephemeral request token",
      expect.objectContaining({
        host: "127.0.0.1"
      })
    );

    await server.close();
  });

  it("unregisters installed signal handlers during shutdown", async () => {
    const beforeSigtermListeners = process.listeners("SIGTERM");
    const beforeSigintListeners = process.listeners("SIGINT");
    const { controls } = createControls("ephemeral");

    try {
      const server = await controls.startHttpServer({
        port: 0,
        allowEphemeralRequestToken: true
      });

      expect(process.listenerCount("SIGTERM")).toBe(beforeSigtermListeners.length + 1);
      expect(process.listenerCount("SIGINT")).toBe(beforeSigintListeners.length + 1);

      await server.close();

      expect(process.listeners("SIGTERM")).toEqual(beforeSigtermListeners);
      expect(process.listeners("SIGINT")).toEqual(beforeSigintListeners);
    } finally {
      removeUnexpectedListeners("SIGTERM", beforeSigtermListeners);
      removeUnexpectedListeners("SIGINT", beforeSigintListeners);
    }
  });

  it("waits for the startup pass before running targeted bulk enrich", async () => {
    let resolveStartup: (() => void) | undefined;
    const runBackgroundPass = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStartup = resolve;
        })
    );
    const runBulkEnrichPass = vi.fn(async () => undefined);
    const { controls } = createControls("env", {
      runBackgroundPass,
      runBulkEnrichPass
    });

    controls.startBackgroundServices();
    const targetedDrain = controls.runGardenBulkEnrichPass("workspace-1");

    expect(runBulkEnrichPass).not.toHaveBeenCalled();
    resolveStartup?.();
    await targetedDrain;

    expect(runBackgroundPass).toHaveBeenCalledTimes(1);
    expect(runBulkEnrichPass).toHaveBeenCalledWith("workspace-1");
  });

  it("closes the recall read worker before closing the database", async () => {
    const order: string[] = [];
    const recallReadWorkerClient = {
      close: vi.fn(async () => {
        order.push("worker");
      })
    };
    const database = {
      close: vi.fn(() => {
        order.push("database");
      })
    };
    const { controls } = createControls("env", {
      recallReadWorkerClient,
      database
    });

    await controls.shutdown();

    expect(recallReadWorkerClient.close).toHaveBeenCalledTimes(1);
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["worker", "database"]);
  });

  it("continues shutdown cleanup when background manager stop throws", async () => {
    const database = { close: vi.fn() };
    const recallReadWorkerClient = { close: vi.fn(async () => undefined) };
    const { controls, warn } = createControls("env", {
      backgroundManagerStop: vi.fn(async () => {
        throw new Error("background-stop-failed");
      }),
      recallReadWorkerClient,
      database
    });

    controls.startBackgroundServices();
    await expect(controls.shutdown()).resolves.toBeUndefined();

    expect(database.close).toHaveBeenCalledTimes(1);
    expect(recallReadWorkerClient.close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "garden background manager shutdown failed",
      expect.objectContaining({ error: "background-stop-failed" })
    );
  });

  it("forces idle and all connection shutdown when server close stalls", async () => {
    vi.useFakeTimers();
    const closeIdleConnections = vi.fn();
    const closeAllConnections = vi.fn();
    function close(_callback?: (error?: Error) => void): void {}
    const serverFactory = vi.fn(() => ({
      close,
      closeIdleConnections,
      closeAllConnections
    }));
    const { controls, warn } = createControls("env", { serverFactory });

    const server = await controls.startHttpServer({ port: 0 });
    const shutdownPromise = server.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closeIdleConnections).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "daemon HTTP server shutdown needed compatibility fallback",
      expect.objectContaining({ result: "timed_out" })
    );
  });

  it("forces process exit when signal shutdown exceeds the bounded timeout", async () => {
    vi.useFakeTimers();
    const processPort = createFakeSignalProcess();
    const { controls, warn } = createControls("env", {
      processPort,
      backgroundManagerStop: vi.fn(
        async () => await new Promise<void>(() => undefined)
      ),
      serverFactory: vi.fn(() => ({
        close(callback?: (error?: Error) => void) {
          callback?.();
        }
      }))
    });

    await controls.startHttpServer({ port: 0 });
    processPort.emitSignal("SIGTERM");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(processPort.exitCode).toBe(1);
    expect(processPort.exit).toHaveBeenCalledWith(1);
    expect(warn).toHaveBeenCalledWith(
      "daemon shutdown timed out after SIGTERM",
      expect.objectContaining({ timeout_ms: 60_000 })
    );
  });

  it("exits the process with code 0 on successful signal shutdown", async () => {
    const processPort = createFakeSignalProcess();
    const { controls } = createControls("env", {
      processPort,
      serverFactory: vi.fn(() => ({
        close(callback?: (error?: Error) => void) {
          callback?.();
        }
      }))
    });

    await controls.startHttpServer({ port: 0 });
    processPort.emitSignal("SIGTERM");
    
    // Wait for the async shutdown chain to finish resolving
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(processPort.exit).toHaveBeenCalledWith(0);
  });

  it("forces process exit immediately with code 1 on second signal shutdown strike", async () => {
    const processPort = createFakeSignalProcess();
    let resolveShutdown: (() => void) | undefined;
    const { controls } = createControls("env", {
      processPort,
      backgroundManagerStop: vi.fn(
        () => new Promise<void>((resolve) => { resolveShutdown = resolve; })
      ),
      serverFactory: vi.fn(() => ({
        close(callback?: (error?: Error) => void) {
          callback?.();
        }
      }))
    });

    await controls.startHttpServer({ port: 0 });
    // First signal strike starts graceful shutdown
    processPort.emitSignal("SIGINT");
    expect(processPort.exit).not.toHaveBeenCalled();

    // Second signal strike triggers immediate exit
    processPort.emitSignal("SIGINT");
    expect(processPort.exit).toHaveBeenCalledWith(1);

    resolveShutdown?.();
  });
});

function removeUnexpectedListeners(signal: NodeJS.Signals, expectedListeners: Function[]): void {
  for (const listener of process.listeners(signal)) {
    if (!expectedListeners.includes(listener)) {
      process.off(signal, listener as NodeJS.SignalsListener);
    }
  }
}
