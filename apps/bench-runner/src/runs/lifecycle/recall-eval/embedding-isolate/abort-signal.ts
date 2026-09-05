export function bindParentAbort(
  parent: AbortSignal | undefined,
  child: AbortController
): () => void {
  if (parent === undefined) return () => undefined;
  const onAbort = () => child.abort(parent.reason);
  if (parent.aborted) {
    onAbort();
    return () => undefined;
  }
  parent.addEventListener("abort", onAbort);
  return () => parent.removeEventListener("abort", onAbort);
}

export function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : cancellationError("operation"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function timeoutError(timeoutMs: number, label: string): Error {
  return new Error(`${label} timed out after ${timeoutMs}ms`);
}

export function cancellationError(label: string): Error {
  const error = new Error(`${label} cancelled`);
  error.name = "AbortError";
  return error;
}

export function isTimeoutError(error: unknown): error is Error {
  return error instanceof Error && /timed out after \d+ms/u.test(error.message);
}

export function isCancellationError(error: unknown, label: string): boolean {
  return error instanceof Error && error.message === `${label} cancelled`;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
