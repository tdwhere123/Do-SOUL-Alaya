export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  // The ONNX feature-extraction run is not cancellable, so on timeout/abort we
  // discard the stale result and suppress its late rejection rather than letting
  // it surface as an unhandledRejection.
  promise.catch(() => undefined);

  const controller = new AbortController();
  const unlinkParentAbort = linkParentAbortSignal(signal, controller);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await raceWithAbortTimeout(promise, controller, timeoutMs, () => {
      timeoutHandle = scheduleTimeoutAbort(controller, timeoutMs);
    });
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
    unlinkParentAbort();
  }
}

function linkParentAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (signal === undefined) {
    return () => undefined;
  }
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const onParentAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onParentAbort, { once: true });
  return () => signal.removeEventListener("abort", onParentAbort);
}

function scheduleTimeoutAbort(
  controller: AbortController,
  timeoutMs: number
): ReturnType<typeof setTimeout> | null {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  const timeoutHandle = setTimeout(
    () => controller.abort(new Error(`Local ONNX embedding timed out after ${timeoutMs} ms.`)),
    timeoutMs
  );
  timeoutHandle.unref?.();
  return timeoutHandle;
}

function raceWithAbortTimeout<T>(
  promise: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  scheduleTimeout: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error(`Local ONNX embedding timed out after ${timeoutMs} ms.`)
      );
    };
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    scheduleTimeout();
    promise.then(resolve, reject);
  });
}
