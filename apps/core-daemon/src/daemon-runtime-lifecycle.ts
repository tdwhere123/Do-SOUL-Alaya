import { serve, type ServerType } from "@hono/node-server";
import type { CoreDaemonLifecycleState } from "./app.js";
import { resolveDaemonHostFromEnv } from "./server-options.js";
import type { AlayaDaemonListenOptions, AlayaDaemonServer } from "./index.js";

type DaemonAppFetch = Parameters<typeof serve>[0]["fetch"];

type LifecycleWarnLogger = Readonly<{
  warn(message: string, meta: Record<string, unknown>): void;
}>;

type GardenRuntimeLifecycle = Readonly<{
  backgroundManager: Readonly<{
    start(): void;
    stop(options: { readonly timeoutMs: number }): Promise<unknown>;
  }>;
  setBacklogTelemetryObserver(observer: unknown | null): void;
  runBackgroundPass(): Promise<void>;
}>;

type GardenBacklogTelemetryLifecycle = Readonly<{
  start(): void;
  stop(): Promise<unknown>;
}>;

type CreateDaemonLifecycleControlsInput = Readonly<{
  app: Readonly<{ fetch: DaemonAppFetch }>;
  lifecycleState: CoreDaemonLifecycleState;
  warnLogger: LifecycleWarnLogger;
  gardenBacklogTelemetryService: GardenBacklogTelemetryLifecycle;
  gardenRuntime: GardenRuntimeLifecycle;
  securityStatusService: Readonly<{ close(): void }>;
  daemonMcpRuntimeRegistry: Readonly<{ close(): Promise<void> }>;
  globalMemoryRecallInvalidationSubscription: Readonly<{ dispose(): void }> | null;
  database: Readonly<{ close(): void }>;
  intervalsToClear?: ReadonlyArray<NodeJS.Timeout>;
}>;

export function createDaemonLifecycleControls(input: CreateDaemonLifecycleControlsInput): Readonly<{
  startBackgroundServices(): void;
  runGardenBackgroundPass(): Promise<void>;
  startHttpServer(options?: AlayaDaemonListenOptions): Promise<AlayaDaemonServer>;
  shutdown(): Promise<void>;
}> {
  let server: ServerType | null = null;
  let backgroundStarted = false;
  let startupBackgroundPass: Promise<void> | null = null;
  let shuttingDown: Promise<void> | null = null;

  const startBackgroundServices = (): void => {
    if (backgroundStarted) {
      return;
    }

    input.gardenBacklogTelemetryService.start();
    input.gardenRuntime.backgroundManager.start();
    backgroundStarted = true;
    const startupPass = input.gardenRuntime.runBackgroundPass().catch((error) => {
      input.warnLogger.warn("garden startup background pass failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    startupBackgroundPass = startupPass;
    void startupPass.finally(() => {
      if (startupBackgroundPass === startupPass) {
        startupBackgroundPass = null;
      }
    });
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown !== null) {
      return await shuttingDown;
    }

    shuttingDown = (async () => {
      // p5-system-review-r3 MR-I06: stop accepting new requests immediately
      // (subsequent requests get 503 from the lifecycle middleware in app.ts)
      // and wait for in-flight handlers to drain before closing the database
      // and tearing down the server. Without this, server.close() only waits
      // for socket idle, leaving handler async chains writing to a closed db.
      input.lifecycleState.drainState.isDraining = true;

      const drainDeadline = Date.now() + 30_000;
      while (input.lifecycleState.inFlight.count > 0 && Date.now() < drainDeadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      if (input.lifecycleState.inFlight.count > 0) {
        input.warnLogger.warn("daemon shutdown drain timed out with in-flight requests", {
          inFlight: input.lifecycleState.inFlight.count
        });
      }

      if (backgroundStarted) {
        await input.gardenRuntime.backgroundManager.stop({ timeoutMs: 30_000 });
        if (startupBackgroundPass !== null) {
          await startupBackgroundPass;
        }
        input.gardenRuntime.setBacklogTelemetryObserver(null);
        const telemetryStopResult = await input.gardenBacklogTelemetryService.stop();
        if (telemetryStopResult === "timed_out") {
          input.warnLogger.warn("garden backlog telemetry shutdown timed out", {});
        }
        backgroundStarted = false;
      }

      input.securityStatusService.close();
      await input.daemonMcpRuntimeRegistry.close();
      input.globalMemoryRecallInvalidationSubscription?.dispose();
      for (const timer of input.intervalsToClear ?? []) {
        clearInterval(timer);
      }

      if (server !== null) {
        await closeServer(server);
        server = null;
      }

      input.database.close();
    })();

    return await shuttingDown;
  };

  return Object.freeze({
    startBackgroundServices,
    runGardenBackgroundPass: async () => {
      if (startupBackgroundPass !== null) {
        await startupBackgroundPass;
      }
      await input.gardenRuntime.runBackgroundPass();
    },
    startHttpServer: async (options: AlayaDaemonListenOptions = {}) => {
      startBackgroundServices();

      if (server !== null) {
        throw new Error("Alaya daemon HTTP server is already running.");
      }

      const hostname = options.hostname ?? resolveDaemonHostFromEnv(process.env);
      const port = options.port ?? parsePort(process.env.PORT, 3000);
      server = serve({
        fetch: input.app.fetch,
        hostname,
        port
      });

      process.on("SIGTERM", () => {
        void shutdown();
      });
      process.on("SIGINT", () => {
        void shutdown();
      });

      input.warnLogger.warn("core daemon listening", {
        host: hostname,
        port,
        url: `http://${hostname}:${port}`
      });

      return Object.freeze({
        hostname,
        port,
        close: shutdown
      });
    },
    shutdown
  });
}

export function createCoreDaemonLifecycleState(): CoreDaemonLifecycleState {
  return {
    drainState: { isDraining: false },
    inFlight: { count: 0 }
  };
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid daemon port: ${value}`);
  }

  return parsed;
}

async function closeServer(server: ServerType): Promise<void> {
  const close = server.close.bind(server) as (callback?: (error?: Error) => void) => void;

  if (close.length === 0) {
    close();
    return;
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    close((error?: Error) => {
      if (error !== undefined) {
        rejectClose(error);
        return;
      }

      resolveClose();
    });
  });
}
