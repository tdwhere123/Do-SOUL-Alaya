/**
 * Serializes worker handlers. Unexpected rejections must not be swallowed —
 * the worker is no longer safe to reuse, so the caller terminates and the
 * client restarts a fresh worker.
 */
export function enqueueRecallReadRequest(
  queue: Promise<void>,
  handle: () => Promise<void>,
  onUnexpectedFailure: (error: unknown) => void
): Promise<void> {
  return queue.then(handle).catch((error: unknown) => {
    onUnexpectedFailure(error);
    return new Promise<void>(() => undefined);
  });
}
