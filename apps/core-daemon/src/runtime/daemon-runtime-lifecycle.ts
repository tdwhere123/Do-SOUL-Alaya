import { serve, type ServerType } from "@hono/node-server";
import type { CoreDaemonLifecycleState, RequestProtectionConfig } from "./app.js";
import { resolveDaemonHostFromEnv } from "./server-options.js";
import type { AlayaDaemonListenOptions, AlayaDaemonServer } from "./daemon-runtime-types.js";

type DaemonAppFetch = Parameters<typeof serve>[0]["fetch"];
type DaemonServerFactory = typeof serve;

type LifecycleWarnLogger = Readonly<{
  warn(message: string, meta: Record<string, unknown>): void;
}>;

type LifecycleProcessPort = {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exitCode?: number | string | null;
  exit(code?: number): never;
};

type LifecycleTimerPort = Readonly<{
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timeout: ReturnType<typeof setTimeout>): void;
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
  processPort?: LifecycleProcessPort;
  serverFactory?: DaemonServerFactory;
  timerPort?: LifecycleTimerPort;
}>;

type LifecycleState = {
  server: ServerType | null;
  backgroundStarted: boolean;
  startupBackgroundPass: Promise<void> | null;
  shuttingDown: Promise<void> | null;
  signalHandlersInstalled: boolean;
  signalShutdownHandlers: SignalShutdownHandler[];
  signalShutdownTimeout: ReturnType<typeof setTimeout> | null;
};

type SignalShutdownHandler = Readonly<{
  signal: "SIGTERM" | "SIGINT";
  listener: () => void;
}>;

type CloseServerResult =
  | "closed"
  | "closed_after_idle_connections"
  | "closed_after_force_close"
  | "timed_out";

const REQUEST_DRAIN_TIMEOUT_MS = 30_000;
const REQUEST_DRAIN_POLL_MIN_MS = 25;
const REQUEST_DRAIN_POLL_MAX_MS = 250;
const BACKGROUND_STOP_TIMEOUT_MS = 30_000;
const SERVER_CLOSE_TIMEOUT_MS = 10_000;
const SERVER_CLOSE_FORCE_GRACE_MS = 1_000;
const SIGNAL_SHUTDOWN_TIMEOUT_MS = 60_000;

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
    signalHandlersInstalled: false,
    signalShutdownHandlers: [],
    signalShutdownTimeout: null
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
    const serverFactory = input.serverFactory ?? serve;
    state.server = serverFactory({
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
  state.signalShutdownHandlers.push(
    installSignalShutdownHandler("SIGTERM", input, state, shutdown),
    installSignalShutdownHandler("SIGINT", input, state, shutdown)
  );
}

function installSignalShutdownHandler(
  signal: "SIGTERM" | "SIGINT",
  input: CreateDaemonLifecycleControlsInput,
  state: LifecycleState,
  shutdown: () => Promise<void>
): SignalShutdownHandler {
  const processPort = input.processPort ?? process;
  const timerPort = input.timerPort ?? defaultLifecycleTimerPort;
  const listener = () => {
    if (state.signalShutdownTimeout !== null) {
      // Second strike: force exit immediately
      input.warnLogger.warn(`received second ${signal}, forcing immediate exit`);
      processPort.exit(1);
      return;
    }

    state.signalShutdownTimeout = timerPort.setTimeout(() => {
      input.warnLogger.warn(`daemon shutdown timed out after ${signal}`, {
        timeout_ms: SIGNAL_SHUTDOWN_TIMEOUT_MS
      });
      processPort.exitCode = 1;
      processPort.exit(1);
    }, SIGNAL_SHUTDOWN_TIMEOUT_MS);
    unrefTimer(state.signalShutdownTimeout);

    void shutdown().then(
      () => {
        clearSignalShutdownTimeout(state, timerPort);
        const exitCode = typeof processPort.exitCode === "number" ? processPort.exitCode : 0;
        processPort.exit(exitCode);
      },
      (error) => {
        input.warnLogger.warn(`daemon shutdown failed after ${signal}`, {
          error: error instanceof Error ? error.message : String(error)
        });
        processPort.exitCode = 1;
        processPort.exit(1);
      }
    );
  };
  processPort.on(signal, listener);
  return { signal, listener };
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
  const timerPort = input.timerPort ?? defaultLifecycleTimerPort;
  const drainDeadline = timerPort.now() + REQUEST_DRAIN_TIMEOUT_MS;
  let attempt = 0;
  while (input.lifecycleState.inFlight.count > 0 && timerPort.now() < drainDeadline) {
    const remainingMs = drainDeadline - timerPort.now();
    await delay(
      Math.max(
        REQUEST_DRAIN_POLL_MIN_MS,
        Math.min(REQUEST_DRAIN_POLL_MIN_MS * 2 ** attempt, REQUEST_DRAIN_POLL_MAX_MS, remainingMs)
      ),
      timerPort
    );
    attempt += 1;
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

  try {
    await input.gardenRuntime.backgroundManager.stop({ timeoutMs: BACKGROUND_STOP_TIMEOUT_MS });
  } catch (error) {
    input.warnLogger.warn("garden background manager shutdown failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  await awaitStartupBackgroundPass(state);
  input.gardenRuntime.setBacklogTelemetryObserver(null);
  try {
    const telemetryStopResult = await input.gardenBacklogTelemetryService.stop();
    if (telemetryStopResult === "timed_out") {
      input.warnLogger.warn("garden backlog telemetry shutdown timed out", {});
    }
  } catch (error) {
    input.warnLogger.warn("garden backlog telemetry shutdown failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  state.backgroundStarted = false;
}

async function closeRuntimeResources(
  input: CreateDaemonLifecycleControlsInput,
  state: LifecycleState
): Promise<void> {
  const processPort = input.processPort ?? process;
  const timerPort = input.timerPort ?? defaultLifecycleTimerPort;
  unregisterSignalShutdownHandlers(state, processPort, timerPort);
  closeRuntimeResourceStep(input, "security status shutdown failed", () => {
    input.securityStatusService.close();
  });
  await closeRuntimeResourceStepAsync(input, "daemon MCP runtime registry shutdown failed", async () => {
    await input.daemonMcpRuntimeRegistry.close();
  });
  closeRuntimeResourceStep(input, "global memory invalidation subscription dispose failed", () => {
    input.globalMemoryRecallInvalidationSubscription?.dispose();
  });
  clearLifecycleIntervals(input.intervalsToClear);

  if (state.server !== null) {
    const closeResult = await closeServer(state.server, timerPort);
    if (closeResult !== "closed") {
      input.warnLogger.warn("daemon HTTP server shutdown needed compatibility fallback", {
        result: closeResult
      });
    }
    state.server = null;
  }

  await closeRecallReadWorkerClient(input);
}

function unregisterSignalShutdownHandlers(
  state: LifecycleState,
  processPort: LifecycleProcessPort,
  timerPort: LifecycleTimerPort
): void {
  for (const { signal, listener } of state.signalShutdownHandlers) {
    processPort.off(signal, listener);
  }
  state.signalShutdownHandlers = [];
  state.signalHandlersInstalled = false;
  clearSignalShutdownTimeout(state, timerPort);
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

async function closeServer(
  server: ServerType,
  timerPort: LifecycleTimerPort
): Promise<CloseServerResult> {
  const close = server.close.bind(server) as (callback?: (error?: Error) => void) => void;

  if (close.length === 0) {
    try {
      close();
      return "closed";
    } catch (error) {
      if (isServerNotRunningError(error)) {
        return "closed";
      }
      throw toError(error);
    }
  }

  const closeResult = new Promise<
    Readonly<{ status: "closed" }> | Readonly<{ status: "error"; error: Error }>
  >((resolveClose) => {
    try {
      close((error?: Error) => {
        if (error !== undefined) {
          if (isServerNotRunningError(error)) {
            resolveClose({ status: "closed" });
            return;
          }
          resolveClose({ status: "error", error });
          return;
        }

        resolveClose({ status: "closed" });
      });
    } catch (error) {
      if (isServerNotRunningError(error)) {
        resolveClose({ status: "closed" });
        return;
      }
      resolveClose({ status: "error", error: toError(error) });
    }
  });

  const initial = await waitForCloseResult(closeResult, SERVER_CLOSE_TIMEOUT_MS, timerPort);
  if (initial.status === "error") {
    throw initial.error;
  }
  if (initial.status === "closed") {
    return "closed";
  }

  closeIdleConnections(server);
  const afterIdle = await waitForCloseResult(closeResult, SERVER_CLOSE_FORCE_GRACE_MS, timerPort);
  if (afterIdle.status === "error") {
    throw afterIdle.error;
  }
  if (afterIdle.status === "closed") {
    return "closed_after_idle_connections";
  }

  closeAllConnections(server);
  const afterForce = await waitForCloseResult(closeResult, SERVER_CLOSE_FORCE_GRACE_MS, timerPort);
  if (afterForce.status === "error") {
    throw afterForce.error;
  }
  if (afterForce.status === "closed") {
    return "closed_after_force_close";
  }

  return "timed_out";
}

function isServerNotRunningError(error: unknown): boolean {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return (
    error instanceof Error &&
    (error.message === "Server is not running." || code === "ERR_SERVER_NOT_RUNNING")
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function closeIdleConnections(server: ServerType): void {
  const candidate = server as { closeIdleConnections?: unknown };
  if (typeof candidate.closeIdleConnections === "function") {
    candidate.closeIdleConnections();
  }
}

function closeAllConnections(server: ServerType): void {
  const candidate = server as { closeAllConnections?: unknown };
  if (typeof candidate.closeAllConnections === "function") {
    candidate.closeAllConnections();
  }
}

async function waitForCloseResult(
  closeResult: Promise<
    Readonly<{ status: "closed" }> | Readonly<{ status: "error"; error: Error }>
  >,
  timeoutMs: number,
  timerPort: LifecycleTimerPort
): Promise<
  | Readonly<{ status: "closed" }>
  | Readonly<{ status: "error"; error: Error }>
  | Readonly<{ status: "timeout" }>
> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<Readonly<{ status: "timeout" }>>((resolve) => {
    timeoutHandle = timerPort.setTimeout(() => {
      resolve({ status: "timeout" });
    }, timeoutMs);
    unrefTimer(timeoutHandle);
  });
  const result = await Promise.race([closeResult, timeoutResult]);
  if (timeoutHandle !== undefined) {
    timerPort.clearTimeout(timeoutHandle);
  }
  return result;
}

function closeRuntimeResourceStep(
  input: CreateDaemonLifecycleControlsInput,
  message: string,
  step: () => void
): void {
  try {
    step();
  } catch (error) {
    input.warnLogger.warn(message, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function closeRuntimeResourceStepAsync(
  input: CreateDaemonLifecycleControlsInput,
  message: string,
  step: () => Promise<void>
): Promise<void> {
  try {
    await step();
  } catch (error) {
    input.warnLogger.warn(message, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function clearSignalShutdownTimeout(
  state: LifecycleState,
  timerPort: LifecycleTimerPort
): void {
  if (state.signalShutdownTimeout === null) {
    return;
  }
  timerPort.clearTimeout(state.signalShutdownTimeout);
  state.signalShutdownTimeout = null;
}

async function delay(ms: number, timerPort: LifecycleTimerPort): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = timerPort.setTimeout(resolve, ms);
    unrefTimer(timeout);
  });
}

function unrefTimer(timeout: ReturnType<typeof setTimeout>): void {
  if (typeof timeout === "object" && timeout !== null && "unref" in timeout && typeof timeout.unref === "function") {
    timeout.unref();
  }
}

const defaultLifecycleTimerPort: LifecycleTimerPort = Object.freeze({
  now: () => Date.now(),
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (timeout) => {
    clearTimeout(timeout);
  }
});
