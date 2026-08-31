// Thin local stall backstop: core cannot import soul's withWallClockTimeout.
// Timeout + no leaked timers. The caller owns the AbortController.
// see also: packages/soul/src/garden/scheduling/wall-clock-timeout.ts withWallClockTimeout

export async function raceAgainstTransportBackstop<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error
): Promise<T> {
  let backstopHandle: ReturnType<typeof setTimeout> | null = null;
  const backstop = new Promise<never>((_resolve, reject) => {
    backstopHandle = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);
    backstopHandle.unref?.();
  });
  try {
    return await Promise.race([work, backstop]);
  } finally {
    if (backstopHandle !== null) {
      clearTimeout(backstopHandle);
    }
  }
}
