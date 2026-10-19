import process from "node:process";
import {
  classifyBatchCampaignFailure,
  runBatchCampaign
} from "../../runs/extraction/fill/batch-campaign.js";
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
    // The stop may predate the first published window state, and provider
    // messages may carry request content; report only the bounded category.
    process.stderr.write(`Batch campaign stopped: ${classifyBatchCampaignFailure(cause)}; ` +
      "the failure may predate any published window state, so check the manifest path, " +
      "its JSON, and referenced artifacts, then the published state\n");
    return 2;
  }
}
