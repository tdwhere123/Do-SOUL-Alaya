import type { HistoryLayout } from "../history.js";

export async function runLongMemEval(
  _layout: HistoryLayout,
  _outPath: string | undefined
): Promise<number> {
  process.stderr.write(
    "alaya-eval longmemeval: runner stub in place; LongMemEval-S driver not yet implemented.\n"
  );
  return 0;
}
