export const DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS = 10_000;
const INTERNAL_TIMEOUT = Object.freeze({ source: "timeout" as const });
export const CALLER_ABORT = Object.freeze({ source: "caller" as const });

export type ProviderChatDeadlineOptions = Readonly<{ timeoutMs?: number; abortSignal?: AbortSignal }>;
type ProviderChatDeadline = Readonly<{
  signal: AbortSignal;
  settle<T>(work: Promise<T>): Promise<T>;
  dispose(): void;
}>;

/** Owns settlement and cleanup even when the underlying operation cannot be cancelled. */
export function createProviderChatDeadline(options: ProviderChatDeadlineOptions): ProviderChatDeadline {
  const controller = new AbortController();
  const onAbort = (): void => { controller.abort(CALLER_ABORT); };
  if (options.abortSignal?.aborted === true) onAbort();
  else options.abortSignal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(INTERNAL_TIMEOUT), resolveProviderChatTimeoutMs(options.timeoutMs));
  timer.unref?.();
  return {
    signal: controller.signal,
    settle: <T>(work: Promise<T>): Promise<T> => settleUnlessAborted(work, controller.signal),
    dispose: (): void => {
      clearTimeout(timer);
      options.abortSignal?.removeEventListener("abort", onAbort);
    }
  };
}

export function resolveProviderChatTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs : DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS;
}

async function settleUnlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw abortCause(signal);
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortCause(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } catch (error) {
    if (signal.aborted) void work.catch(() => undefined);
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function abortCause(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
