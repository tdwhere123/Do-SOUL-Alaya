export type LifecycleTimerPort = Readonly<{
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timeout: ReturnType<typeof setTimeout>): void;
}>;

export async function delay(ms: number, timerPort: LifecycleTimerPort): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = timerPort.setTimeout(resolve, ms);
    unrefTimer(timeout);
  });
}

export function unrefTimer(timeout: ReturnType<typeof setTimeout>): void {
  if (
    typeof timeout === "object" &&
    timeout !== null &&
    "unref" in timeout &&
    typeof timeout.unref === "function"
  ) {
    timeout.unref();
  }
}

export const defaultLifecycleTimerPort: LifecycleTimerPort = Object.freeze({
  now: () => Date.now(),
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (timeout) => {
    clearTimeout(timeout);
  }
});
