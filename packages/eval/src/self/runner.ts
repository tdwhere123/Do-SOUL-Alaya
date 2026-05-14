import type { HistoryLayout } from "../history.js";

export async function runSelfBench(
  _layout: HistoryLayout,
  _outPath: string | undefined
): Promise<number> {
  process.stderr.write(
    "alaya-eval self: stub — Phase 4 of v0.3.6 wires the golden + synthetic runners; nothing written today.\n"
  );
  return 0;
}
