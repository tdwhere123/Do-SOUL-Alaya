import type { Dispatcher } from "undici";

export type ProviderTransportCleanup = Readonly<{
  status: "pending" | "closed" | "destroyed" | "failed";
  failures: readonly Readonly<{ operation: "close" | "destroy"; cause: unknown }>[];
}>;

const CLEANUPS = new WeakMap<object, { current: ProviderTransportCleanup | undefined }>();

/** Cleanup is independent of request success and never grants another dispatch. */
export function providerTransportCleanupOf(outcome: unknown): ProviderTransportCleanup | undefined {
  return typeof outcome === "object" && outcome !== null ? CLEANUPS.get(outcome)?.current : undefined;
}

export function createTransportCleanupOwner() {
  const state: { current: ProviderTransportCleanup | undefined } = { current: undefined };
  return {
    acquired(): void {
      state.current = Object.freeze({ status: "pending", failures: [] });
    },
    bind(outcome: unknown): void {
      if (typeof outcome === "object" && outcome !== null) CLEANUPS.set(outcome, state);
    },
    async retire(dispatcher: Dispatcher, completed: boolean): Promise<void> {
      const failures: { operation: "close" | "destroy"; cause: unknown }[] = [];
      let status: ProviderTransportCleanup["status"] = "failed";
      if (completed) {
        try { await boundedRetirement(() => dispatcher.close()); status = "closed"; }
        catch (cause) { failures.push({ operation: "close", cause }); }
      }
      if (status !== "closed") {
        try { await boundedRetirement(() => dispatcher.destroy()); status = "destroyed"; }
        catch (cause) { failures.push({ operation: "destroy", cause }); }
      }
      // A failed owned dispatcher is never shared or reused by a later attempt.
      state.current = Object.freeze({ status, failures: Object.freeze(failures.map(failure => Object.freeze(failure))) });
    }
  };
}

async function boundedRetirement(work: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("provider transport retirement timed out")), 1_000);
      timer.unref?.();
    })]);
  } finally {
    clearTimeout(timer);
  }
}
