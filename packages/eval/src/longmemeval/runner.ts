import type { HistoryLayout } from "../history.js";

export async function runLongMemEval(
  _layout: HistoryLayout,
  _outPath: string | undefined
): Promise<number> {
  process.stderr.write(
    "alaya-eval longmemeval: stub — Phase 5 of v0.3.6 wires the LongMemEval-S driver; nothing written today.\n"
  );
  return 0;
}
