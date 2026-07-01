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
  recallReadWorkerClient?: Readonly<{ close(): Promise<void> }> | null;
  database: Readonly<{ close(): void }>;
  requestProtection: RequestProtectionConfig;
  intervalsToClear?: ReadonlyArray<NodeJS.Timeout>;
}>;

type LifecycleState = {
  server: ServerType | null;
  backgroundStarted: boolean;
  startupBackgroundPass: Promise<void> | null;
  shuttingDown: Promise<void> | null;
  signalHandlersInstalled: boolean;
};

export function createDaemonLifecycleControls(input: CreateDaemonLifecycleControlsInput): Readonly<{
  startBackgroundServices(): void;
  runGardenBackgroundPass(): Promise<void>;
  runGardenBulkEnrichPass(workspaceId: string): Promise<void>;
  runGardenEmbeddingBackfillPass(workspaceId: string): Promise<void>;
  startHttpServer(options?: AlayaDaemonListenOptions): Promise<AlayaDaemonServer>;
  shutdown(): Promise<void>;
}> {
  const state: LifecycleState = {
    server: null,
    backgroundStarted: false,
    startupBackgroundPass: null,
    shuttingDown: null,
    signalHandlersInstalled: false
  };
  const startBackgroundServices = createBackgroundServiceStarter(input, state);
  const shutdown = createShutdownHandler(input, state);
  const startHttpServer = createHttpServerStarter(input, state, startBackgroundServices, shutdown);

  return Object.freeze({
    startBackgroundServices,
    runGardenBackgroundPass: async () => {
      await awaitStartupBackgroundPass(state);
      await input.gardenRuntime.runBackgroundPass();
    },
    // invariant: targeted BULK_ENRICH drain (bench edge-plane readiness), not
    // a full Garden maintenance pass. Waits for any in-flight startup pass so
    // the workspace-scoped drain sees a settled queue and does not race the
    // initial all-workspace background sweep.
    runGardenBulkEnrichPass: async (workspaceId: string) => {
      await awaitStartupBackgroundPass(state);
      await input.gardenRuntime.runBulkEnrichPass(workspaceId);
    },
    // invariant: targeted embedding-backfill drain (bench/warmup readiness),
    // not a full Garden maintenance pass. Waits for any in-flight startup pass
    // first (same ordering guard as runGardenBackgroundPass) so the drain sees
    // a settled queue, then dispatches ONLY EMBEDDING_BACKFILL.
    // see also: garden-runtime.ts runEmbeddingBackfillPass.
    runGardenEmbeddingBackfillPass: async (workspaceId: string) => {
      await awaitStartupBackgroundPass(state);
      await input.gardenRuntime.runEmbeddingBackfillPass(workspaceId);
    },
    startHttpServer,
    shutdown
  });
}

function createBackgroundServiceStarter(
  input: CreateDaemonLifecycleControlsInput,
  state: LifecycleState
): () => void {
  return () => {
    if (state.backgroundStarted) {
      return;
    }

    input.gardenBacklogTelemetryService.start();
    input.gardenRuntime.backgroundManager.start();
    state.backgroundStarted = true;
    const startupPass = input.gardenRuntime.runBackgroundPass().catch((error) => {
      input.warnLogger.warn("garden startup background pass failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    state.startupBackgroundPass = startupPass;
    void startupPass.finally(() => {
      if (state.startupBackgroundPass === startupPass) {
        state.startupBackgroundPass = null;
      }
    });
  };
}

async function awaitStartupBackgroundPass(state: LifecycleState): Promise<void> {
  if (state.startupBackgroundPass !== null) {
    await state.startupBackgroundPass;
  }
}

function createShutdownHandler(
  input: CreateDaemonLifecycleControlsInput,
  state: LifecycleState
): () => Promise<void> {
  return async () => {
    if (state.shuttingDown !== null) {
      return await state.shuttingDown;
    }

    state.shuttingDown = (async () => {
      await drainInFlightRequests(input);
      await stopBackgroundServices(input, state);
      await closeRuntimeResources(input, state);
      input.database.close();
    })();

    return await state.shuttingDown;
  };
}

function createHttpServerStarter(
  input: CreateDaemonLifecycleControlsInput,
  state: LifecycleState,
  startBackgroundServices: () => void,
  shutdown: () => Promise<void>
): (options?: AlayaDaemonListenOptions) => Promise<AlayaDaemonServer> {
  return async (options: AlayaDaemonListenOptions = {}) => {
    validateEphemeralTokenPolicy(input.requestProtection, options);
    startBackgroundServices();
    ensureServerNotRunning(state);
    logEphemeralTokenStartup(input, options);

    const hostname = options.hostname ?? resolveDaemonHostFromEnv(process.env);
    const port = options.port ?? parsePort(process.env.PORT, 3000);
    state.server = serve({
      fetch: input.app.fetch,
      hostname,
      port
    });
    installSignalShutdownHandlersOnce(state, input, shutdown);
    logListeningAddress(input, hostname, port);
    return Object.freeze({ hostname, port, close: shutdown });
  };
}

function validateEphemeralTokenPolicy(
  requestProtection: RequestProtectionConfig,
  options: AlayaDaemonListenOptions
): void {
  const allowEphemeralRequestToken = options.allowEphemeralRequestToken ?? false;
  if (requestProtection.tokenSource === "ephemeral" && !allowEphemeralRequestToken) {
    throw new Error(
      "ALAYA_REQUEST_TOKEN must be set before starting the daemon HTTP server. Use `alaya inspect` for a managed temporary daemon or set ALAYA_REQUEST_TOKEN explicitly."
    );
  }
}

function ensureServerNotRunning(state: LifecycleState): void {
  if (state.server !== null) {
    throw new Error("Alaya daemon HTTP server is already running.");
  }
}

function logEphemeralTokenStartup(
  input: CreateDaemonLifecycleControlsInput,
  options: AlayaDaemonListenOptions
): void {
  if (input.requestProtection.tokenSource !== "ephemeral") {
    return;
  }

  input.warnLogger.warn("starting managed daemon with ephemeral request token", {
    host: options.hostname ?? resolveDaemonHostFromEnv(process.env),
    port: options.port ?? parsePort(process.env.PORT, 3000)
  });
}

function installSignalShutdownHandlersOnce(
  state: LifecycleState,
  input: CreateDaemonLifecycleControlsInput,
  shutdown: () => Promise<void>
): void {
  if (state.signalHandlersInstalled) {
    return;
  }
  state.signalHandlersInstalled = true;
  installSignalShutdownHandler("SIGTERM", input, shutdown);
  installSignalShutdownHandler("SIGINT", input, shutdown);
}

function installSignalShutdownHandler(
  signal: "SIGTERM" | "SIGINT",
  input: CreateDaemonLifecycleControlsInput,
  shutdown: () => Promise<void>
): void {
  process.on(signal, () => {
    void shutdown().catch((error) => {
      input.warnLogger.warn(`daemon shutdown failed after ${signal}`, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

function logListeningAddress(
  input: CreateDaemonLifecycleControlsInput,
  hostname: string,
  port: number
): void {
  input.warnLogger.warn("core daemon listening", {
    host: hostname,
    port,
    url: `http://${hostname}:${port}`
  });
}

async function drainInFlightRequests(input: CreateDaemonLifecycleControlsInput): Promise<void> {
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
}

async function stopBackgroundServices(
  input: CreateDaemonLifecycleControlsInput,
  state: LifecycleState
): Promise<void> {
  if (!state.backgroundStarted) {
    return;
  }

  await input.gardenRuntime.backgroundManager.stop({ timeoutMs: 30_000 });
  await awaitStartupBackgroundPass(state);
  input.gardenRuntime.setBacklogTelemetryObserver(null);
  const telemetryStopResult = await input.gardenBacklogTelemetryService.stop();
  if (telemetryStopResult === "timed_out") {
    input.warnLogger.warn("garden backlog telemetry shutdown timed out", {});
  }
  state.backgroundStarted = false;
}

async function closeRuntimeResources(
  input: CreateDaemonLifecycleControlsInput,
  state: LifecycleState
): Promise<void> {
  input.securityStatusService.close();
  await input.daemonMcpRuntimeRegistry.close();
  input.globalMemoryRecallInvalidationSubscription?.dispose();
  clearLifecycleIntervals(input.intervalsToClear);

  if (state.server !== null) {
    await closeServer(state.server);
    state.server = null;
  }

  await closeRecallReadWorkerClient(input);
}

function clearLifecycleIntervals(
  intervalsToClear: ReadonlyArray<NodeJS.Timeout> | undefined
): void {
  for (const timer of intervalsToClear ?? []) {
    clearInterval(timer);
  }
}

async function closeRecallReadWorkerClient(
  input: CreateDaemonLifecycleControlsInput
): Promise<void> {
  if (input.recallReadWorkerClient === undefined || input.recallReadWorkerClient === null) {
    return;
  }

  try {
    await input.recallReadWorkerClient.close();
  } catch (error) {
    input.warnLogger.warn("recall read worker shutdown failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
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
