import { buildRecallCandidateSelectionKey } from
  "../../../runtime/recall-candidate-builder.js";
import type { FineAssessmentAccumulator } from
  "../../fine-assessment-selection/types.js";
import type {
  FineAssessmentPreProjectionAction,
  FineAssessmentPreProjectionCapture,
  FineAssessmentPreProjectionObservation,
  FineAssessmentProjectionAction
} from "../selection-boundary-types.js";

export function captureFineAssessmentPreProjection(
  accumulator: FineAssessmentAccumulator
): FineAssessmentPreProjectionCapture {
  const receipts = accumulator.admissionReceipts;
  if (
    receipts === undefined ||
    receipts.length !== accumulator.diagnostics.length
  ) {
    throw new Error("selection boundary pre-projection action mismatch");
  }
  const admissionActions = Object.freeze(accumulator.diagnostics.map(
    (diagnostic, index) => buildPreProjectionAction(
      diagnostic,
      receipts[index]!
    )
  ));
  const candidateKeys = Object.freeze(admissionActions
    .filter((action) => action.action === "retain")
    .map((action) => action.candidate_key));
  assertSelectedCandidateIdentity(accumulator, candidateKeys);
  return Object.freeze({
    schema_version: 1 as const,
    candidate_keys: candidateKeys,
    token_total: accumulator.selected.reduce(
      (total, candidate) => total + candidate.token_estimate,
      0
    ),
    admission_actions: admissionActions
  });
}

export function completeFineAssessmentPreProjection(
  capture: FineAssessmentPreProjectionCapture,
  deliveredCandidateKeys: readonly string[]
): FineAssessmentPreProjectionObservation {
  const preProjectionKeys = new Set(capture.candidate_keys);
  const deliveredRankByKey = new Map(
    deliveredCandidateKeys.map((key, index) => [key, index + 1])
  );
  const retainedDelivered = deliveredCandidateKeys.filter((key) =>
    preProjectionKeys.has(key)
  );
  let retainedIndex = 0;
  const projectionActions = Object.freeze(capture.candidate_keys.map(
    (candidateKey, index) => {
      const deliveredRank = deliveredRankByKey.get(candidateKey) ?? null;
      const retainedInOrder = deliveredRank !== null &&
        retainedDelivered[retainedIndex] === candidateKey;
      if (deliveredRank !== null) retainedIndex += 1;
      return buildProjectionAction(
        candidateKey,
        index + 1,
        deliveredRank,
        retainedInOrder
      );
    }
  ));
  const introducedCandidateKeys = Object.freeze(deliveredCandidateKeys.filter(
    (key) => !preProjectionKeys.has(key)
  ));
  const orderedSubsequence = introducedCandidateKeys.length === 0 &&
    projectionActions.every((action) =>
      action.reason_code !== "unwitnessed_reorder"
    );
  return Object.freeze({
    ...capture,
    projection_actions: projectionActions,
    introduced_candidate_keys: introducedCandidateKeys,
    ordered_subsequence: orderedSubsequence,
    qualified_ordered_subsequence: orderedSubsequence &&
      projectionActions.every((action) => action.qualification === "permitted")
  });
}

function buildProjectionAction(
  candidateKey: string,
  preProjectionRank: number,
  deliveredRank: number | null,
  retainedInOrder: boolean
): FineAssessmentProjectionAction {
  const reasonCode = deliveredRank === null
    ? "unwitnessed_exclusion" as const
    : retainedInOrder
      ? "stable_order_identity" as const
      : "unwitnessed_reorder" as const;
  return Object.freeze({
    candidate_key: candidateKey,
    action: deliveredRank === null ? "exclude" as const : "retain" as const,
    pre_projection_rank: preProjectionRank,
    delivered_rank: deliveredRank,
    qualification: reasonCode === "stable_order_identity"
      ? "permitted" as const
      : "ineligible" as const,
    reason_code: reasonCode,
    witness: Object.freeze({
      kind: "rank_transition" as const,
      pre_projection_rank: preProjectionRank,
      delivered_rank: deliveredRank
    })
  });
}

function buildPreProjectionAction(
  diagnostic: FineAssessmentAccumulator["diagnostics"][number],
  witness: FineAssessmentPreProjectionAction["witness"]
): FineAssessmentPreProjectionAction {
  const retained = diagnostic.dropped_reason === null;
  assertReceiptMatchesDiagnostic(witness, diagnostic.dropped_reason);
  return Object.freeze({
    candidate_key: diagnostic.candidate_key,
    action: retained ? "retain" as const : "exclude" as const,
    selection_order: diagnostic.selection_order,
    pre_projection_rank: retained ? diagnostic.final_rank : null,
    dropped_reason: diagnostic.dropped_reason,
    witness
  });
}

function assertSelectedCandidateIdentity(
  accumulator: FineAssessmentAccumulator,
  candidateKeys: readonly string[]
): void {
  const selectedKeys = accumulator.selected.map(buildRecallCandidateSelectionKey);
  if (
    selectedKeys.length !== candidateKeys.length ||
    selectedKeys.some((key, index) => key !== candidateKeys[index])
  ) {
    throw new Error("selection boundary pre-projection identity mismatch");
  }
}

function assertReceiptMatchesDiagnostic(
  witness: FineAssessmentPreProjectionAction["witness"],
  droppedReason: FineAssessmentPreProjectionAction["dropped_reason"]
): void {
  if (
    (droppedReason === null && witness.kind !== "retained") ||
    (droppedReason !== null && witness.kind !== droppedReason)
  ) {
    throw new Error("selection boundary admission receipt mismatch");
  }
}
