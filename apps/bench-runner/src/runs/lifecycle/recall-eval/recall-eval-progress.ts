import type { RecallEvalHarnessTimers } from "./recall-eval-contract.js";

export function writeRecallEvalProgress(
  questionIndex: number,
  totalQuestions: number,
  questionId: string,
  result: Readonly<{
    readonly hitAt5: boolean;
    readonly latencyMs: number;
    readonly harnessTimers?: RecallEvalHarnessTimers;
  }>
): void {
  const wallSuffix = formatHarnessWallSuffix(result.harnessTimers);
  process.stdout.write(
    `[recall-eval ${questionIndex + 1}/${totalQuestions}] ${questionId.slice(0, 8)} ` +
    `R@5=${result.hitAt5 ? "✓" : "✗"} latency=${result.latencyMs.toFixed(0)}ms${wallSuffix}\n`
  );
}

function formatHarnessWallSuffix(
  timers: RecallEvalHarnessTimers | undefined
): string {
  if (timers === undefined) return "";
  const wall = `wall=${timers.totalWallMs.toFixed(0)}ms`;
  return typeof timers.harnessOverheadMs === "number" &&
    Number.isFinite(timers.harnessOverheadMs)
    ? ` (${wall}, overhead=${timers.harnessOverheadMs.toFixed(0)}ms)`
    : ` (${wall})`;
}
