import type { RequestStartState } from "./request-start-state.js";

const MILLISECONDS_PER_MINUTE = 60_000;

export interface RequestStartPacer {
  readonly wait: (signal?: AbortSignal) => Promise<void>;
}

export function createRequestStartPacer(input: {
  readonly requestsPerMinute: number;
  readonly state: RequestStartState;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): RequestStartPacer {
  const interval = resolveMinimumStartInterval(input.requestsPerMinute);
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  let lastStartAt = input.state.readLastStartAt();
  let tail = Promise.resolve();
  return Object.freeze({
    wait: async (signal: AbortSignal | undefined) => {
      signal?.throwIfAborted();
      let release: (() => void) | undefined;
      const preceding = tail;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      tail = preceding.then(() => current);
      try {
        await awaitAbortable(preceding, signal);
        const earliestStart = lastStartAt === undefined ? now() : lastStartAt + interval;
        await sleepUntil(earliestStart, now, sleep, signal);
        signal?.throwIfAborted();
        const startedAt = now();
        input.state.recordStartAt(startedAt);
        lastStartAt = startedAt;
      } finally {
        release?.();
      }
    }
  });
}

function resolveMinimumStartInterval(requestsPerMinute: number): number {
  if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1) {
    throw new Error("request pacer requestsPerMinute must be a positive safe integer");
  }
  return Math.floor(MILLISECONDS_PER_MINUTE / requestsPerMinute) + 1;
}

async function sleepUntil(
  earliestStart: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
  signal: AbortSignal | undefined
): Promise<void> {
  const delay = earliestStart - now();
  if (delay > 0) await awaitAbortable(sleep(delay), signal);
}

function awaitAbortable(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(
      signal.reason ?? new Error("direct DeepSeek request pacing was aborted")
    ));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => finish(resolve),
      (error) => finish(() => reject(error))
    );
  });
}
