export class ExtractionNoProgressError extends Error {
  constructor(timeoutMs: number) {
    super(`extraction made no progress for ${timeoutMs}ms`);
    this.name = "ExtractionNoProgressError";
  }
}

export function createExtractionNoProgressWatchdog(input: {
  readonly timeoutMs: number;
  readonly externalSignal?: AbortSignal;
  readonly now?: () => number;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}): {
  readonly signal: AbortSignal;
  readonly markProgress: () => void;
  readonly dispose: () => void;
} {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error("extraction no-progress timeout must be a positive safe integer");
  }
  const controller = new AbortController();
  const now = input.now ?? Date.now;
  const schedule = input.setInterval ?? setInterval;
  const cancel = input.clearInterval ?? clearInterval;
  let lastProgressAt = now();
  const forwardAbort = (): void => controller.abort(input.externalSignal?.reason);
  if (input.externalSignal?.aborted === true) forwardAbort();
  else input.externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = schedule(() => {
    if (controller.signal.aborted || now() - lastProgressAt < input.timeoutMs) return;
    controller.abort(new ExtractionNoProgressError(input.timeoutMs));
  }, Math.min(input.timeoutMs, 5_000));
  timer.unref?.();
  return {
    signal: controller.signal,
    markProgress: () => { lastProgressAt = now(); },
    dispose: () => {
      cancel(timer);
      input.externalSignal?.removeEventListener("abort", forwardAbort);
    }
  };
}
