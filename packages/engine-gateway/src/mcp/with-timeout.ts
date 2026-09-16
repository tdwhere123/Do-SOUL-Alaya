export interface HandlerTimeoutError {
  readonly error_code: "handler_timeout";
  readonly message: string;
  readonly error_type: "TimeoutError";
}

function makeTimeoutError(): HandlerTimeoutError {
  return {
    error_code: "handler_timeout",
    message: "MCP tool execution timed out.",
    error_type: "TimeoutError"
  };
}

export function isHandlerTimeoutError(error: unknown): error is HandlerTimeoutError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { error_code?: unknown }).error_code === "handler_timeout"
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined || !signal.aborted) {
    return;
  }
  if (signal.reason !== undefined) {
    throw signal.reason;
  }
  throw makeTimeoutError();
}

export async function withTimeout<T>(
  work: ((signal: AbortSignal) => Promise<T>) | Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = makeTimeoutError();
      // Signal cooperative cancellation before rejecting so an abort-aware
      // operation can stop its inner work.
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  const operation = typeof work === "function" ? work(controller.signal) : work;
  // An abandoned operation that rejects after the race resolves must not become
  // an unhandledRejection (which would shut the daemon down).
  operation.catch(() => undefined);
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
