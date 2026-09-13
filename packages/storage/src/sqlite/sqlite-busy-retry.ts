const SQLITE_BUSY_PRIMARY_CODE = 5;
const SQLITE_LOCKED_PRIMARY_CODE = 6;
export const DEFAULT_SQLITE_BUSY_RETRY_LIMIT = 5;
export const DEFAULT_SQLITE_BUSY_RETRY_SLEEP_MS = 20;

export interface SqliteBusyRetryOptions {
  readonly retryLimit?: number;
  readonly sleepMs?: number;
  /** Wall-clock cap so a nested busy_timeout cannot multiply retry attempts. */
  readonly budgetMs?: number;
}

export function withSqliteBusyRetry<T>(
  operation: () => T,
  options?: SqliteBusyRetryOptions
): T {
  const sleepMs = options?.sleepMs ?? DEFAULT_SQLITE_BUSY_RETRY_SLEEP_MS;
  const retryLimit = options?.retryLimit ?? DEFAULT_SQLITE_BUSY_RETRY_LIMIT;
  const deadline = options?.budgetMs === undefined ? undefined : Date.now() + options.budgetMs;
  let lastError: unknown;
  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    // Check before the call: sqlite busy_timeout waits inside operation().
    if (attempt > 0 && deadline !== undefined && Date.now() >= deadline) {
      throw lastError;
    }
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === retryLimit - 1) {
        throw error;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }
  throw lastError;
}

export function isSqliteBusyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === "object") {
      const errcode = "errcode" in current ? (current as { readonly errcode?: unknown }).errcode : undefined;
      if (typeof errcode === "number") {
        const primary = errcode & 0xff;
        if (primary === SQLITE_BUSY_PRIMARY_CODE || primary === SQLITE_LOCKED_PRIMARY_CODE) {
          return true;
        }
      }
      const code = "code" in current ? (current as { readonly code?: unknown }).code : undefined;
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
        return true;
      }
    }
    const message = current instanceof Error ? current.message : String(current);
    // Do not match generic "busy": Windows sharing / "resource busy" never clear.
    if (/sqlite_busy|sqlite_locked|database is locked/i.test(message)) {
      return true;
    }
    current = typeof current === "object" && current !== null && "cause" in current
      ? (current as { readonly cause?: unknown }).cause
      : undefined;
  }
  return false;
}
