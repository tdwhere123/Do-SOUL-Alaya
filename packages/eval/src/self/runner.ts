import type { HistoryLayout } from "../history.js";

export async function runSelfBench(
  _layout: HistoryLayout,
  _outPath: string | undefined
): Promise<number> {
  process.stderr.write(
    "alaya-eval self: runner stub in place; golden + synthetic execution not yet implemented.\n"
  );
  return 0;
}
