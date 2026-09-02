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
  const wallSuffix = result.harnessTimers !== undefined
    ? ` (wall=${result.harnessTimers.totalWallMs.toFixed(0)}ms, overhead=${result.harnessTimers.harnessOverheadMs.toFixed(0)}ms)`
    : "";
  process.stdout.write(
    `[recall-eval ${questionIndex + 1}/${totalQuestions}] ${questionId.slice(0, 8)} ` +
    `R@5=${result.hitAt5 ? "✓" : "✗"} latency=${result.latencyMs.toFixed(0)}ms${wallSuffix}\n`
  );
}
