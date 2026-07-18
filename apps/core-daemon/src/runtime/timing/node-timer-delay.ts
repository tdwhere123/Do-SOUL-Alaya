export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export function parseNodeTimerDelayMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(
      `${label} must be a safe integer between 1 and ${MAX_NODE_TIMER_DELAY_MS}`
    );
  }
  return value;
}
