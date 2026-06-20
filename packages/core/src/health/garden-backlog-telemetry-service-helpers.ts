const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeStopTimeoutMs(
  timeoutMs: number | null | undefined
): number | null {
  if (timeoutMs === null) {
    return null;
  }

  if (timeoutMs === undefined) {
    return DEFAULT_STOP_TIMEOUT_MS;
  }

  return Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : DEFAULT_STOP_TIMEOUT_MS;
}

export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | false> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

export async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref?.();
  });
}
