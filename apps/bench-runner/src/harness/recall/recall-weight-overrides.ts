import type { RecallPolicy } from "@do-soul/alaya-protocol";
import type { RecallWeightOverridesSummary } from "@do-soul/alaya-eval";

export const ALAYA_RECALL_WEIGHT_OVERRIDES_ENV = "ALAYA_RECALL_WEIGHT_OVERRIDES";

// Archived provenance still names this shape; live execution rejects it.
export interface BenchRecallWeightOverrides {
  readonly source: "cli" | "env";
  readonly summary: RecallWeightOverridesSummary;
}

export function resolveBenchRecallWeightOverrides(input: {
  readonly cliJson?: string;
  readonly envJson?: string;
}): BenchRecallWeightOverrides | undefined {
  if (input.cliJson?.trim() || input.envJson?.trim()) {
    throw new Error("recall weight overrides are retired; conditional-field Recall has no fusion or activation-weight selector");
  }
  return undefined;
}

export function applyBenchRecallWeightOverrides(
  policy: RecallPolicy,
  overrides: BenchRecallWeightOverrides | undefined
): RecallPolicy {
  if (overrides !== undefined) {
    throw new Error("recall weight overrides are retired; conditional-field Recall has no fusion or activation-weight selector");
  }
  return policy;
}

export function formatBenchRecallWeightOverrides(overrides: BenchRecallWeightOverrides): string {
  return JSON.stringify(overrides.summary);
}
