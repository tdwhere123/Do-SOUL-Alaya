export function isRetryableProviderHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export interface ProviderRetryOptions {
  readonly delaysMs: readonly number[];
  readonly isRetryable: (error: unknown, attempt: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly waitForRetry?: (attempt: number, scheduledMs: number) => Promise<void>;
}

export async function withProviderRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: ProviderRetryOptions
): Promise<T> {
  const sleep = options.sleep ?? defaultProviderRetrySleep;
  const waitForRetry = options.waitForRetry ??
    ((attempt: number, scheduledMs: number) => sleep(options.delaysMs[attempt] ?? scheduledMs));
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.delaysMs.length; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      if (!options.isRetryable(error, attempt) || attempt === options.delaysMs.length) {
        throw error;
      }
      await waitForRetry(attempt, options.delaysMs[attempt] ?? 0);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("provider request failed");
}

function defaultProviderRetrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
