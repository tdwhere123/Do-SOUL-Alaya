export function attachRecallEvalHarnessTimers(
  pack: unknown,
  durations: {
    readonly openDurationMs: number;
    readonly recallDurationMs: number;
    readonly totalWallMs: number;
  }
): Record<string, unknown> {
  if (pack === undefined || !hasRecallPack(pack)) {
    throw new Error("recall-eval pager child returned an empty pack.");
  }
  const record = pack as Record<string, unknown>;
  const clockAMs = finiteMs(record.latencyMs);
  record.harnessTimers = Object.freeze(
    clockAMs === undefined
      ? {
        openDurationMs: durations.openDurationMs,
        recallDurationMs: durations.recallDurationMs,
        totalWallMs: durations.totalWallMs
      }
      : {
        openDurationMs: durations.openDurationMs,
        recallDurationMs: durations.recallDurationMs,
        totalWallMs: durations.totalWallMs,
        clockAMs,
        harnessOverheadMs: Math.max(0, durations.totalWallMs - clockAMs)
      }
  );
  return record;
}

function hasRecallPack(pack: unknown): boolean {
  if (typeof pack !== "object" || pack === null) return false;
  const record = pack as { readonly questionId?: unknown; readonly diagnostics?: unknown };
  return typeof record.questionId === "string" &&
    record.questionId.length > 0 &&
    record.diagnostics !== undefined &&
    record.diagnostics !== null;
}

function finiteMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
