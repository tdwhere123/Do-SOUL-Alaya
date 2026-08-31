import type { RecallEvalOptions } from
  "../../../../../runs/lifecycle/recall-eval/recall-eval-contract.js";
import type { RecallEvalSnapshotBundle } from
  "../../../../../runs/snapshot/recall-eval/recall-eval-loader.js";
import type { BenchRecallWeightOverrides } from
  "../../../../../harness/recall/recall-weight-overrides.js";

export async function assertExpansionRecallAuthority(input: {
  readonly options: RecallEvalOptions;
  readonly bundle: RecallEvalSnapshotBundle;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  if (input.options.expansionCapability !== undefined) {
    throw new Error("expansion/promotion contracts are not supported");
  }
}
