import type { ServerType } from "@hono/node-server";
import { type LifecycleTimerPort, unrefTimer } from "./daemon-runtime-timing.js";

export type CloseServerResult =
  | "closed"
  | "closed_after_idle_connections"
  | "closed_after_force_close"
  | "timed_out";

type ServerCloseOutcome =
  | Readonly<{ status: "closed" }>
  | Readonly<{ status: "error"; error: Error }>;

const SERVER_CLOSE_TIMEOUT_MS = 10_000;
const SERVER_CLOSE_FORCE_GRACE_MS = 1_000;

export async function closeServer(
  server: ServerType,
  timerPort: LifecycleTimerPort
): Promise<CloseServerResult> {
  const closeResult = beginServerClose(server);
  const initial = await waitForCloseResult(closeResult, SERVER_CLOSE_TIMEOUT_MS, timerPort);
  assertNoCloseError(initial);
  if (initial.status === "closed") {
    return "closed";
  }

  closeServerConnections(server, "idle");
  const afterIdle = await waitForCloseResult(closeResult, SERVER_CLOSE_FORCE_GRACE_MS, timerPort);
  assertNoCloseError(afterIdle);
  if (afterIdle.status === "closed") {
    return "closed_after_idle_connections";
  }

  closeServerConnections(server, "all");
  const afterForce = await waitForCloseResult(closeResult, SERVER_CLOSE_FORCE_GRACE_MS, timerPort);
  assertNoCloseError(afterForce);
  return afterForce.status === "closed" ? "closed_after_force_close" : "timed_out";
}

function beginServerClose(server: ServerType): Promise<ServerCloseOutcome> {
  const close = server.close.bind(server) as (callback?: (error?: Error) => void) => void;
  if (close.length === 0) {
    return Promise.resolve(closeServerWithoutCallback(close));
  }

  return new Promise<ServerCloseOutcome>((resolveClose) => {
    try {
      close((error?: Error) => {
        resolveClose(normalizeCloseCallbackError(error));
      });
    } catch (error) {
      resolveClose(normalizeCloseThrownError(error));
    }
  });
}

function closeServerWithoutCallback(
  close: (callback?: (error?: Error) => void) => void
): ServerCloseOutcome {
  try {
    close();
    return { status: "closed" };
  } catch (error) {
    return normalizeCloseThrownError(error);
  }
}

function normalizeCloseCallbackError(error: Error | undefined): ServerCloseOutcome {
  if (error === undefined || isServerNotRunningError(error)) {
    return { status: "closed" };
  }
  return { status: "error", error };
}

function normalizeCloseThrownError(error: unknown): ServerCloseOutcome {
  if (isServerNotRunningError(error)) {
    return { status: "closed" };
  }
  return { status: "error", error: toError(error) };
}

function assertNoCloseError(
  result: ServerCloseOutcome | Readonly<{ status: "timeout" }>
): void {
  if (result.status === "error") {
    throw result.error;
  }
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

function closeServerConnections(server: ServerType, mode: "idle" | "all"): void {
  const methodName = mode === "idle" ? "closeIdleConnections" : "closeAllConnections";
  const candidate = server as Record<typeof methodName, unknown>;
  const method = candidate[methodName];
  if (typeof method === "function") {
    method.call(server);
  }
}

async function waitForCloseResult(
  closeResult: Promise<ServerCloseOutcome>,
  timeoutMs: number,
  timerPort: LifecycleTimerPort
): Promise<ServerCloseOutcome | Readonly<{ status: "timeout" }>> {
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
