import {
  selectFineAssessmentCandidates,
  type FineAssessmentSelectionParams,
  type FineAssessmentSelectionResult
} from "../fine-assessment-selection.js";
import { applyDeliverySelection } from "../delivery-selection.js";
import {
  resolveFineAssessmentDeliveryBranch,
  type FineAssessmentDeliveryBranch
} from "../fine-assessment-delivery-branch.js";
import { resolveFineAssessmentDeepHead } from
  "../fine-assessment-deep-head.js";
import type {
  RecallDeepHeadAssessment,
  RecallDeepHeadTrace
} from "../../rerank/deep-head.js";
import { buildSelectionBoundaryExpected } from
  "./selection-boundary-capture.js";
import {
  createCapturedTokenEstimator,
  restoreSupplementaryData,
  validateSelectionBoundary
} from "./selection-boundary-restore.js";
import type {
  FineAssessmentSelectionBoundaryCase,
  FineAssessmentSelectionBoundaryInput,
  FineAssessmentPreProjectionCapture,
  SelectionBoundaryNumberMap
} from "./selection-boundary-types.js";
import {
  selectionBoundaryJsonSha256
} from "./selection-boundary-json.js";
import type { FineAssessmentSelectionBoundaryPendingCapture } from
  "./selection-boundary-capture.js";

export const SELECTION_COMPOSITION_FIDELITY_MISMATCH =
  "selection composition fidelity mismatch";

/** Reconstruct no longer accepts a second order policy; the exported name stays for callers. */
export type SelectionCompositionOptions = Readonly<{}>;

export type SelectionCompositionReconstruction = Readonly<{
  readonly result: FineAssessmentSelectionResult;
  readonly branch: FineAssessmentDeliveryBranch;
  readonly deepHead: RecallDeepHeadAssessment;
  readonly delivery: ReturnType<typeof applyDeliverySelection>;
}>;

/**
 * Reconstruct selection from a captured boundary via the live delivery seam.
 * Must stay bit-identical to `deliverFineAssessment` branch + apply + select.
 */
export function reconstructFineAssessmentComposition(
  boundary: FineAssessmentSelectionBoundaryCase
): SelectionCompositionReconstruction {
  validateSelectionBoundary(boundary);
  const input = boundary.input;
  const candidates = input.ordered_candidates;
  const supplementaryData = restoreSupplementaryData(input.supplementary_data);
  const answerRelevanceScores =
    supplementaryData.answerRelevanceScoresByCandidateKey ?? new Map();
  const deepHead = resolveFineAssessmentDeepHead({
    candidates,
    answerRelevanceScores,
    supplementaryData,
    captureAnswerFeatures: input.capture_answer_features
  });
  const branch = resolveFineAssessmentDeliveryBranch({
    answerRelevanceScores
  });
  const delivery = applyDeliverySelection(candidates, deepHead.scores, {
    replacePublicRelevance: branch.replacePublicRelevance
  });
  assertCompositionInputs(input, delivery, deepHead);
  let pending: FineAssessmentSelectionBoundaryPendingCapture | undefined;
  const selectionParams = buildCompositionSelectionParams(
    input,
    supplementaryData,
    delivery,
    deepHead
  );
  const selected = selectFineAssessmentCandidates({
    ...selectionParams,
    ...(boundary.expected.pre_projection === undefined ? {} : {
      selectionBoundaryObserver: (capture) => {
        pending = capture;
        return undefined;
      }
    })
  });
  assertCompositionExpected(boundary, selected, pending?.preProjection);
  return Object.freeze({
    result: selected,
    branch,
    deepHead,
    delivery
  });
}

/** Shared selectFineAssessmentCandidates params for composition and CF. */
export function buildCompositionSelectionParams(
  input: FineAssessmentSelectionBoundaryInput,
  supplementaryData: ReturnType<typeof restoreSupplementaryData>,
  delivery: ReturnType<typeof applyDeliverySelection>,
  deepHead: RecallDeepHeadAssessment,
  tokenEstimator: FineAssessmentSelectionParams["tokenEstimator"] =
    createCapturedTokenEstimator(input.token_estimates_by_content)
): FineAssessmentSelectionParams {
  return {
    orderedCandidates: delivery.orderedCandidates,
    config: input.config,
    supplementaryData,
    tokenEstimator,
    rankByCandidateKey: delivery.rankByCandidateKey,
    finalRelevanceByCandidateKey: delivery.finalRelevanceByCandidateKey,
    coverageRelevanceByCandidateKey: deepHead.scores,
    coverageRelevanceUpperBound: deepHead.relevanceUpperBoundReceipt,
    ...(input.coverage_objective_config === undefined ? {} : {
      coverageObjectiveConfig: input.coverage_objective_config
    }),
    answerRelevanceRankByCandidateKey:
      delivery.answerRelevanceRankByCandidateKey,
    ...(input.capture_answer_features === undefined ? {} : {
      captureAnswerFeatures: input.capture_answer_features
    }),
    capturePacketPlanTrace: true,
    deepHeadTraceByCandidateKey: deepHead.traceByCandidateKey
  };
}

function assertCompositionInputs(
  input: FineAssessmentSelectionBoundaryInput,
  delivery: ReturnType<typeof applyDeliverySelection>,
  deepHead: RecallDeepHeadAssessment
): void {
  assertCandidateOrder(delivery.orderedCandidates, input.ordered_candidates);
  assertNumberMapEquals(
    delivery.rankByCandidateKey,
    input.rank_by_candidate_key
  );
  assertNumberMapEquals(
    delivery.finalRelevanceByCandidateKey,
    input.final_relevance_by_candidate_key
  );
  assertNumberMapEquals(
    delivery.answerRelevanceRankByCandidateKey,
    input.answer_relevance_rank_by_candidate_key
  );
  assertNumberMapEquals(
    deepHead.scores,
    input.coverage_relevance_by_candidate_key
  );
  if (selectionBoundaryJsonSha256(deepHead.relevanceUpperBoundReceipt) !==
      selectionBoundaryJsonSha256(
        input.coverage_relevance_upper_bound ?? null
      )) {
    throwCompositionMismatch();
  }
  assertDeepHeadTraces(
    deepHead.traceByCandidateKey,
    input.deep_head_trace_by_candidate_key,
    input.capture_answer_features === true
  );
}

function assertCompositionExpected(
  boundary: FineAssessmentSelectionBoundaryCase,
  selected: FineAssessmentSelectionResult,
  preProjection?: FineAssessmentPreProjectionCapture
): void {
  const packetConsensus = selected.packetPlanObservation;
  if (packetConsensus === undefined) throwCompositionMismatch();
  const actual = buildSelectionBoundaryExpected(
    selected,
    packetConsensus,
    boundary.input.capture_packet_plan_trace === true,
    preProjection
  );
  if (
    selectionBoundaryJsonSha256(actual) !==
    selectionBoundaryJsonSha256(boundary.expected)
  ) {
    throwCompositionMismatch();
  }
}

function assertCandidateOrder(
  actual: ReturnType<typeof applyDeliverySelection>["orderedCandidates"],
  captured: FineAssessmentSelectionBoundaryInput["ordered_candidates"]
): void {
  if (actual.length !== captured.length) throwCompositionMismatch();
  for (let index = 0; index < actual.length; index += 1) {
    if (
      actual[index]!.fusion.candidate_key !==
      captured[index]!.fusion.candidate_key
    ) {
      throwCompositionMismatch();
    }
  }
}

function assertNumberMapEquals(
  actual: ReadonlyMap<string, number>,
  captured: SelectionBoundaryNumberMap | undefined
): void {
  const entries = captured ?? [];
  if (actual.size !== entries.length) throwCompositionMismatch();
  for (const [key, value] of entries) {
    if (actual.get(key) !== value) throwCompositionMismatch();
  }
}

function assertDeepHeadTraces(
  actual: ReadonlyMap<string, RecallDeepHeadTrace>,
  captured: readonly (readonly [string, RecallDeepHeadTrace])[] | undefined,
  captureAnswerFeatures: boolean
): void {
  if (!captureAnswerFeatures) {
    if (actual.size !== 0) throwCompositionMismatch();
    if (captured !== undefined && captured.length > 0) {
      throwCompositionMismatch();
    }
    return;
  }
  if (captured === undefined || actual.size !== captured.length) {
    throwCompositionMismatch();
  }
  for (const [key, value] of captured) {
    const recomputed = actual.get(key);
    if (recomputed === undefined) throwCompositionMismatch();
    if (
      selectionBoundaryJsonSha256(recomputed) !==
      selectionBoundaryJsonSha256(value)
    ) {
      throwCompositionMismatch();
    }
  }
}

function throwCompositionMismatch(): never {
  throw new Error(SELECTION_COMPOSITION_FIDELITY_MISMATCH);
}
