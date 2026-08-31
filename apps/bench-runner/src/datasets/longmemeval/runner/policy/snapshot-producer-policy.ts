import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/authority";
import type { BenchRecallWeightOverrides } from
  "../../../../harness/recall/recall-weight-overrides.js";
import { assertProductFormationEnvironment } from
  "../../promotion/product/product-formation-policy.js";
import type { LongMemEvalRunOptions } from "../../runner.js";
import { assertLongMemEvalTreatmentNeutralEdgeFormation } from
  "../edge-formation-config.js";

export interface SnapshotProducerStaticPolicyInput {
  readonly opts: LongMemEvalRunOptions;
  readonly policyShape: NonNullable<LongMemEvalRunOptions["policyShape"]>;
  readonly simulateReport: NonNullable<LongMemEvalRunOptions["simulateReport"]>;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
  readonly releaseEvidenceAuthority: LongMemEvalReleaseEvidenceAuthority | null;
}

export function assertSnapshotProducerStaticPolicy(
  input: SnapshotProducerStaticPolicyInput,
  env: Readonly<Record<string, string | undefined>>
): void {
  assertSnapshotProducerInvocationPolicy(input, env);
  assertSnapshotProducerReleaseAuthority(input);
}

export function assertSnapshotProducerInvocationPolicy(
  input: SnapshotProducerStaticPolicyInput,
  env: Readonly<Record<string, string | undefined>>
): void {
  assertProductFormationEnvironment(env, "snapshot producer product formation");
  assertLongMemEvalTreatmentNeutralEdgeFormation(env);
  if (input.policyShape !== "stress" || input.simulateReport !== "none" ||
      input.recallWeightOverrides !== undefined || input.opts.qa !== undefined ||
      (input.opts.embeddingMode ?? "disabled") !== "disabled") {
    throw new Error(
      "snapshot production requires stress/none, neutral recall weights and embedding, and QA off"
    );
  }
}

export function assertSnapshotProducerReleaseAuthority(
  input: SnapshotProducerStaticPolicyInput
): void {
  if (input.releaseEvidenceAuthority === null) {
    throw new Error("snapshot production requires canonical pinned dataset authority");
  }
}
