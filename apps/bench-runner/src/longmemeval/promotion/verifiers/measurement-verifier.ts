import { isDeepStrictEqual } from "node:util";
import {
  applyQuestionMeasurementAxes,
  buildQuestionMeasurementAxes
} from "../../diagnostics/diagnostics-measurement-axes.js";
import type {
  LongMemEvalQuestionDiagnostic,
  LongMemEvalQuestionMeasurementAxes
} from "../../diagnostics/schema/diagnostics-types.js";
import {
  classifyQuestionMeasurementCohort,
  classifyQuestionMeasurementStatus
} from "../../measurement/question-validity.js";
import type { SnapshotQuestionMeasurementOracle } from
  "../../snapshot/measurement-oracle.js";
import { createEmptyLongMemEvalSeedDropReasons } from
  "../../extraction/seed-fuel/seed-drop-reasons.js";
import { verifyPromotionGoldEvidence } from "./gold-verifier.js";
import {
  buildLongMemEvalSidecarKey,
  resolveLongMemEvalGoldObjectKind
} from "../../runner/runner-scoring.js";
import type { LongMemEvalGoldObjectIdentity } from
  "../../diagnostics/gold-object-identities.js";

export interface VerifiedPromotionQuestionMeasurement {
  readonly diagnostic: LongMemEvalQuestionDiagnostic;
  readonly status: ReturnType<typeof classifyQuestionMeasurementStatus>;
  readonly cohort: ReturnType<typeof classifyQuestionMeasurementCohort>;
  readonly scorable: boolean;
  readonly hits: ReturnType<typeof verifyPromotionGoldEvidence>;
}

export function verifyPromotionQuestionMeasurement(input: {
  readonly diagnostic: LongMemEvalQuestionDiagnostic;
  readonly expectedGold?: readonly string[];
  readonly expectedGoldIdentities?: readonly LongMemEvalGoldObjectIdentity[];
  readonly oracle: SnapshotQuestionMeasurementOracle;
}): VerifiedPromotionQuestionMeasurement {
  if (input.diagnostic.is_abstention !== input.oracle.isAbstention) {
    throw new Error("recall-eval KPI row differs from snapshot abstention identity");
  }
  const persistedStatus = classifyQuestionMeasurementStatus(input.diagnostic);
  assertEqual(
    input.diagnostic.seed_drop_reasons ?? createEmptyLongMemEvalSeedDropReasons(),
    input.oracle.seedDropReasons,
    "answer seed drop reasons"
  );
  const hits = verifyPromotionGoldEvidence({
    question: input.diagnostic,
    expectedGold: input.expectedGold,
    expectedGoldIdentities: input.expectedGoldIdentities,
    scorable: persistedStatus === "scorable"
  });
  const axes = buildCanonicalAxes(input);
  assertEqual(input.diagnostic.quality_axes, axes, "question measurement axes");
  assertEqual(
    input.diagnostic.cohort_ledger?.quality_axes,
    axes,
    "cohort ledger measurement axes"
  );
  const diagnostic = applyQuestionMeasurementAxes(input.diagnostic, axes);
  assertMeasurementClassification(input.diagnostic, diagnostic, axes);
  const status = classifyQuestionMeasurementStatus(diagnostic);
  if (status !== persistedStatus) {
    throw new Error("evaluator identity status differs from canonical measurement");
  }
  return {
    diagnostic,
    status,
    hits,
    scorable: status === "scorable",
    cohort: classifyQuestionMeasurementCohort(diagnostic)
  };
}

function buildCanonicalAxes(
  input: Parameters<typeof verifyPromotionQuestionMeasurement>[0]
): LongMemEvalQuestionMeasurementAxes {
  const { diagnostic, oracle } = input;
  return buildQuestionMeasurementAxes({
    answer: oracle.answer,
    answerSessionIds: oracle.answerSessionIds,
    sourceDatesBySession: oracle.sourceDatesBySession,
    deliveredResults: diagnostic.delivered_results,
    candidates: diagnostic.candidates,
    sidecar: oracle.sidecar,
    isAbstention: oracle.isAbstention,
    evaluatorGoldMemoryIds: oracle.goldMemoryIds,
    evaluatorGoldEvidenceIds: oracle.goldEvidenceIds,
    evaluatorGoldObjectIds: oracle.goldObjectIds,
    evaluatorHitAt5: independentHitAt5(
      diagnostic,
      oracle.goldObjectIdentities
    )
  });
}

function independentHitAt5(
  diagnostic: LongMemEvalQuestionDiagnostic,
  goldIdentities: readonly LongMemEvalGoldObjectIdentity[]
): boolean {
  const gold = new Set(goldIdentities.map((identity) =>
    buildLongMemEvalSidecarKey(identity.objectKind, identity.objectId)));
  return diagnostic.delivered_results.some((result) => {
    const objectKind = resolveLongMemEvalGoldObjectKind(result.object_kind);
    return result.rank <= 5 && objectKind !== null &&
      gold.has(buildLongMemEvalSidecarKey(objectKind, result.object_id));
  });
}

function assertMeasurementClassification(
  persisted: LongMemEvalQuestionDiagnostic,
  recomputed: LongMemEvalQuestionDiagnostic,
  axes: LongMemEvalQuestionMeasurementAxes
): void {
  const status = axes.evaluator_identity_integrity_at_5.status;
  if (status === "inconsistent" || status === "indeterminate") {
    assertEqual(
      identityClassification(persisted),
      identityClassification(recomputed),
      "evaluator identity classification"
    );
    return;
  }
  const ledger = persisted.cohort_ledger;
  if (persisted.miss_classification === "evaluator_identity_inconsistent" ||
      persisted.miss_classification === "evaluator_identity_indeterminate" ||
      ledger?.evaluation_issue_reason === "evaluator_data_identity_inconsistency" ||
      ledger?.evaluation_issue_reason === "evaluator_data_identity_indeterminate") {
    throw new Error("evaluator identity classification differs from canonical measurement");
  }
}

function identityClassification(diagnostic: LongMemEvalQuestionDiagnostic) {
  const ledger = diagnostic.cohort_ledger;
  return {
    missClassification: diagnostic.miss_classification,
    missTaxonomy: diagnostic.miss_taxonomy,
    measurementStatus: ledger?.measurement_status,
    retrievalStatus: ledger?.retrieval_status,
    evaluationIssueReason: ledger?.evaluation_issue_reason,
    finalVerdict: ledger?.final_verdict
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} differs from independently recomputed diagnostics`);
  }
}
