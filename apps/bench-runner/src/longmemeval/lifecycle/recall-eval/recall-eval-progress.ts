export function writeRecallEvalProgress(
  questionIndex: number,
  totalQuestions: number,
  questionId: string,
  result: Readonly<{ readonly hitAt5: boolean; readonly latencyMs: number }>
): void {
  process.stdout.write(
    `[recall-eval ${questionIndex + 1}/${totalQuestions}] ${questionId.slice(0, 8)} ` +
      `R@5=${result.hitAt5 ? "✓" : "✗"} latency=${result.latencyMs}ms\n`
  );
}
