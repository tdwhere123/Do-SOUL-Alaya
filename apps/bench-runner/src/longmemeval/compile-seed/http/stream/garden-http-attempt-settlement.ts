const WALL_CLOCK_TICK_MS = 5_000;

export interface GardenHttpAttemptSettlement {
  readonly promise: Promise<never>;
  readonly hasTimedOut: () => boolean;
  readonly noteProgress: () => void;
  readonly dispose: () => void;
}

interface GardenHttpAttemptSettlementInput {
  readonly idleTimeoutMs: number;
  readonly controller: AbortController;
  readonly operatorAbortSignal?: AbortSignal;
}

export function startGardenHttpAttemptSettlement(
  input: GardenHttpAttemptSettlementInput
): GardenHttpAttemptSettlement {
  let timedOut = false;
  let lastProgressAt = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectSettlement: ((error: Error) => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectSettlement = reject;
  });
  const fireTimeout = (): void => {
    if (timedOut) return;
    timedOut = true;
    input.controller.abort();
    rejectSettlement?.(new Error(
      `garden extraction transport stalled for ${input.idleTimeoutMs}ms`
    ));
  };
  const armIdleTimer = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(fireTimeout, input.idleTimeoutMs);
    idleTimer.unref?.();
  };
  const noteProgress = (): void => {
    if (timedOut) return;
    lastProgressAt = Date.now();
    armIdleTimer();
  };
  const wallClockTimer = setInterval(() => {
    if (Date.now() - lastProgressAt >= input.idleTimeoutMs) fireTimeout();
  }, WALL_CLOCK_TICK_MS);
  wallClockTimer.unref?.();
  const onOperatorAbort = (): void => {
    input.controller.abort();
    rejectSettlement?.(new Error("garden extraction operator aborted"));
  };
  addAbortListener(input.operatorAbortSignal, onOperatorAbort);
  armIdleTimer();
  return {
    promise,
    hasTimedOut: () => timedOut,
    noteProgress,
    dispose: () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      clearInterval(wallClockTimer);
      input.operatorAbortSignal?.removeEventListener("abort", onOperatorAbort);
    }
  };
}

function addAbortListener(
  signal: AbortSignal | undefined,
  listener: () => void
): void {
  if (signal === undefined) return;
  if (signal.aborted) {
    listener();
    return;
  }
  signal.addEventListener("abort", listener);
}
