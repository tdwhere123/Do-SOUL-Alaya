import process from "node:process";
import { runBatchCampaign } from "../../runs/extraction/fill/batch-campaign.js";
import { ExtractionFillInterruptedError, withExtractionFillSignalScope } from "./signal-scope.js";

export async function runBatchCampaignCommand(args: readonly string[]): Promise<number> {
  const resetStopped = args.includes("--reset-stopped");
  const rest = args.filter((arg) => arg !== "--reset-stopped");
  if (rest.length !== 2 || rest[0] !== "--batch-campaign" || !rest[1]) {
    process.stderr.write("extraction-fill --batch-campaign requires exactly one manifest path\n");
    return 2;
  }
  try {
    const result = await withExtractionFillSignalScope(process, (signal) => runBatchCampaign(rest[1]!, {
      signal, log: (state) => process.stdout.write(`${JSON.stringify(state)}\n`),
      ...(resetStopped ? { resetStopped: true } : {})
    }));
    return result.status === "complete" ? 0 : 2;
  } catch (cause) {
    if (cause instanceof ExtractionFillInterruptedError) return cause.exitCode;
    process.stderr.write("Batch campaign could not continue; inspect its manifest and current window state\n");
    return 2;
  }
}
