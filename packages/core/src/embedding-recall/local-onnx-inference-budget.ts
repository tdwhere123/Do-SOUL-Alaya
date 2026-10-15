interface EmbeddingDeadline {
  readonly signal: AbortSignal;
  readonly close: () => void;
}

export function createEmbeddingDeadline(timeoutMs: number, parent?: AbortSignal): EmbeddingDeadline {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted === true) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`Local ONNX embedding timed out after ${timeoutMs} ms.`)), timeoutMs)
    : null;
  timer?.unref?.();
  return { signal: controller.signal, close: () => {
    if (timer !== null) clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  } };
}

export function throwIfEmbeddingCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw embeddingCancellationError(signal);
}

/** Caller cancellation never releases physical inference occupancy early. */
export function waitForEmbeddingCaller<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(embeddingCancellationError(signal));
      void work.catch(() => undefined);
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(value => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(embeddingCancellationError(signal));
      else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function embeddingCancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Local ONNX embedding was cancelled.");
}
