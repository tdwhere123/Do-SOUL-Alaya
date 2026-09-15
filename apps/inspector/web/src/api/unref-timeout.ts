// DOM lib types `setTimeout` as number; Node's Timeout.unref is not on that type.
export function unrefTimeout(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== "object" || timer === null) return;
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
}
