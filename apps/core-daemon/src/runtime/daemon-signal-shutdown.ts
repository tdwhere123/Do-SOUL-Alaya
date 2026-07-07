import { type LifecycleTimerPort, unrefTimer } from "./daemon-runtime-timing.js";

export type LifecycleWarnLogger = Readonly<{
  warn(message: string, meta: Record<string, unknown>): void;
}>;

export type LifecycleProcessPort = {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exitCode?: number | string | null;
  exit(code?: number): never;
};

export type SignalShutdownHandler = Readonly<{
  signal: "SIGTERM" | "SIGINT";
  listener: () => void;
}>;

type SignalShutdownState = {
  signalShutdownTimeout: ReturnType<typeof setTimeout> | null;
};

const SIGNAL_SHUTDOWN_TIMEOUT_MS = 60_000;

export function installSignalShutdownHandler(input: {
  readonly signal: "SIGTERM" | "SIGINT";
  readonly processPort: LifecycleProcessPort;
  readonly timerPort: LifecycleTimerPort;
  readonly warnLogger: LifecycleWarnLogger;
  readonly state: SignalShutdownState;
  readonly shutdown: () => Promise<void>;
}): SignalShutdownHandler {
  const listener = () => {
    if (input.state.signalShutdownTimeout !== null) {
      forceExitAfterSecondSignal(input);
      return;
    }

    input.state.signalShutdownTimeout = input.timerPort.setTimeout(() => {
      forceExitAfterTimeout(input);
    }, SIGNAL_SHUTDOWN_TIMEOUT_MS);
    unrefTimer(input.state.signalShutdownTimeout);
    void runSignalShutdown(input);
  };
  input.processPort.on(input.signal, listener);
  return { signal: input.signal, listener };
}

export function clearSignalShutdownTimeout(
  state: SignalShutdownState,
  timerPort: LifecycleTimerPort
): void {
  if (state.signalShutdownTimeout === null) {
    return;
  }
  timerPort.clearTimeout(state.signalShutdownTimeout);
  state.signalShutdownTimeout = null;
}

function forceExitAfterSecondSignal(input: {
  readonly signal: "SIGTERM" | "SIGINT";
  readonly processPort: LifecycleProcessPort;
  readonly warnLogger: LifecycleWarnLogger;
}): void {
  input.warnLogger.warn(`received second ${input.signal}, forcing immediate exit`, {});
  exitProcess(input.processPort, 1);
}

function forceExitAfterTimeout(input: {
  readonly signal: "SIGTERM" | "SIGINT";
  readonly processPort: LifecycleProcessPort;
  readonly warnLogger: LifecycleWarnLogger;
}): void {
  input.warnLogger.warn(`daemon shutdown timed out after ${input.signal}`, {
    timeout_ms: SIGNAL_SHUTDOWN_TIMEOUT_MS
  });
  input.processPort.exitCode = 1;
  exitProcess(input.processPort, 1);
}

async function runSignalShutdown(input: {
  readonly signal: "SIGTERM" | "SIGINT";
  readonly processPort: LifecycleProcessPort;
  readonly timerPort: LifecycleTimerPort;
  readonly warnLogger: LifecycleWarnLogger;
  readonly state: SignalShutdownState;
  readonly shutdown: () => Promise<void>;
}): Promise<void> {
  try {
    await input.shutdown();
    clearSignalShutdownTimeout(input.state, input.timerPort);
    const exitCode = typeof input.processPort.exitCode === "number" ? input.processPort.exitCode : 0;
    exitProcess(input.processPort, exitCode);
  } catch (error) {
    input.warnLogger.warn(`daemon shutdown failed after ${input.signal}`, {
      error: error instanceof Error ? error.message : String(error)
    });
    input.processPort.exitCode = 1;
    exitProcess(input.processPort, 1);
  }
}

function exitProcess(processPort: LifecycleProcessPort, code: number): void {
  if (processPort !== process || process.env.NODE_ENV !== "test") {
    processPort.exit(code);
  }
}
