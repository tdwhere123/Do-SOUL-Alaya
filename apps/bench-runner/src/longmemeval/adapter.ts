import type { BenchCampaignAdapter } from "../bench/index.js";
import { loadDatasetWithIdentity } from "./ingestion/fetch.js";
import type { LongMemEvalQuestion } from "./ingestion/dataset.js";
import type { LongMemEvalRunOptions } from "./runner.js";

/**
 * Dataset plug-in surface for LongMemEval. The live question loop still
 * lives in runner.ts so snapshot, selection, and provenance stay intact.
 */
export const longMemEvalCampaignIdentity = {
  benchName: "public-longmemeval",
  split: "longmemeval_s",
  diagnosticsFilename: "longmemeval-diagnostics.json",
  baselinePointerKind: "run"
} as const;

export async function loadLongMemEvalCampaignDataset(
  opts: LongMemEvalRunOptions
): Promise<readonly LongMemEvalQuestion[]> {
  const loaded = await loadDatasetWithIdentity(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  return loaded.questions;
}

export type LongMemEvalCampaignAdapter = BenchCampaignAdapter<
  LongMemEvalRunOptions,
  LongMemEvalQuestion,
  unknown
>;
