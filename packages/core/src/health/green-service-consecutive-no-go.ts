import type { GreenWarnPort } from "./green-service-ports.js";

export function defaultGreenWarn(message: string, meta: Record<string, unknown>): void {
  process.emitWarning(message, {
    code: "ALAYA_GREEN_SERVICE_WARNING",
    detail: JSON.stringify(meta)
  });
}

export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function readConsecutiveNoGo(
  cache: Map<string, number>,
  targetObjectId: string
): number {
  const count = cache.get(targetObjectId);
  if (count === undefined) {
    return 0;
  }
  cache.delete(targetObjectId);
  cache.set(targetObjectId, count);
  return count;
}

export function writeConsecutiveNoGo(input: {
  readonly cache: Map<string, number>;
  readonly targetObjectId: string;
  readonly count: number;
  readonly maxEntries: number;
  readonly warn: GreenWarnPort;
}): void {
  if (input.cache.has(input.targetObjectId)) {
    input.cache.delete(input.targetObjectId);
  }
  while (input.cache.size >= input.maxEntries) {
    const oldestTargetObjectId = input.cache.keys().next().value;
    if (typeof oldestTargetObjectId !== "string") {
      break;
    }
    input.cache.delete(oldestTargetObjectId);
    input.warn("[GreenService] consecutive No-Go cache entry evicted.", {
      targetObjectId: oldestTargetObjectId,
      maxEntries: input.maxEntries
    });
  }
  input.cache.set(input.targetObjectId, input.count);
}
