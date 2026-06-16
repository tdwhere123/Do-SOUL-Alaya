import { serve, type ServerType } from "@hono/node-server";
import type { CoreDaemonLifecycleState, RequestProtectionConfig } from "./app.js";
import { resolveDaemonHostFromEnv } from "./server-options.js";
import type { AlayaDaemonListenOptions, AlayaDaemonServer } from "./daemon-runtime-types.js";

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
  runBulkEnrichPass(workspaceId: string): Promise<void>;
  runEmbeddingBackfillPass(workspaceId: string): Promise<void>;
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
  requestProtection: RequestProtectionConfig;
  intervalsToClear?: ReadonlyArray<NodeJS.Timeout>;
}>;

export function createDaemonLifecycleControls(input: CreateDaemonLifecycleControlsInput): Readonly<{
  startBackgroundServices(): void;
  runGardenBackgroundPass(): Promise<void>;
  runGardenBulkEnrichPass(workspaceId: string): Promise<void>;
  runGardenEmbeddingBackfillPass(workspaceId: string): Promise<void>;
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
      // Stop accepting new requests immediately and wait for in-flight
      // handlers to drain before closing the database and tearing down the
      // server. Without this, server.close() only waits for socket idle,
      // leaving handler async chains writing to a closed db.
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
    // invariant: targeted BULK_ENRICH drain (bench edge-plane readiness), not
    // a full Garden maintenance pass. Waits for any in-flight startup pass so
    // the workspace-scoped drain sees a settled queue and does not race the
    // initial all-workspace background sweep.
    runGardenBulkEnrichPass: async (workspaceId: string) => {
      if (startupBackgroundPass !== null) {
        await startupBackgroundPass;
      }
      await input.gardenRuntime.runBulkEnrichPass(workspaceId);
    },
    // invariant: targeted embedding-backfill drain (bench/warmup readiness),
    // not a full Garden maintenance pass. Waits for any in-flight startup pass
    // first (same ordering guard as runGardenBackgroundPass) so the drain sees
    // a settled queue, then dispatches ONLY EMBEDDING_BACKFILL.
    // see also: garden-runtime.ts runEmbeddingBackfillPass.
    runGardenEmbeddingBackfillPass: async (workspaceId: string) => {
      if (startupBackgroundPass !== null) {
        await startupBackgroundPass;
      }
      await input.gardenRuntime.runEmbeddingBackfillPass(workspaceId);
    },
    startHttpServer: async (options: AlayaDaemonListenOptions = {}) => {
      const allowEphemeralRequestToken = options.allowEphemeralRequestToken ?? false;
      if (input.requestProtection.tokenSource === "ephemeral" && !allowEphemeralRequestToken) {
        throw new Error(
          "ALAYA_REQUEST_TOKEN must be set before starting the daemon HTTP server. Use `alaya inspect` for a managed temporary daemon or set ALAYA_REQUEST_TOKEN explicitly."
        );
      }

      startBackgroundServices();

      if (server !== null) {
        throw new Error("Alaya daemon HTTP server is already running.");
      }

      if (input.requestProtection.tokenSource === "ephemeral") {
        input.warnLogger.warn("starting managed daemon with ephemeral request token", {
          host: options.hostname ?? resolveDaemonHostFromEnv(process.env),
          port: options.port ?? parsePort(process.env.PORT, 3000)
        });
      }

      const hostname = options.hostname ?? resolveDaemonHostFromEnv(process.env);
      const port = options.port ?? parsePort(process.env.PORT, 3000);
      server = serve({
        fetch: input.app.fetch,
        hostname,
        port
      });

      process.on("SIGTERM", () => {
        void shutdown().catch((error) => {
          input.warnLogger.warn("daemon shutdown failed after SIGTERM", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      });
      process.on("SIGINT", () => {
        void shutdown().catch((error) => {
          input.warnLogger.warn("daemon shutdown failed after SIGINT", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
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
