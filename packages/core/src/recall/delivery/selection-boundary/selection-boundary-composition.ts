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
import { restoreCapturedPacketCandidates } from
  "./validation/packet-order.js";
import { assertCapturedOrderPolicy } from
  "./validation/captured-order-policy.js";

export const SELECTION_COMPOSITION_FIDELITY_MISMATCH =
  "selection composition fidelity mismatch";

export const CAPTURED_SCORE_FIDELITY_ASSERT = "assert" as const;
export const CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE = "recompute_live" as const;

export type CapturedScoreFidelityMode =
  | typeof CAPTURED_SCORE_FIDELITY_ASSERT
  | typeof CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE;

export type SelectionCompositionOptions = Readonly<{
  readonly capturedScoreFidelity?: CapturedScoreFidelityMode;
}>;

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
  boundary: FineAssessmentSelectionBoundaryCase,
  options: SelectionCompositionOptions = {}
): SelectionCompositionReconstruction {
  const capturedScoreFidelity = resolveCapturedScoreFidelity(options);
  validateSelectionBoundary(boundary);
  const prepared = prepareComposition(boundary.input, capturedScoreFidelity);
  let pending: FineAssessmentSelectionBoundaryPendingCapture | undefined;
  const selected = selectFineAssessmentCandidates({
    ...prepared.selectionParams,
    ...(boundary.expected.pre_projection === undefined ? {} : {
      selectionBoundaryObserver: (capture) => {
        pending = capture;
        return undefined;
      }
    })
  });
  if (capturedScoreFidelity === CAPTURED_SCORE_FIDELITY_ASSERT) {
    assertCompositionExpected(boundary, selected, pending?.preProjection);
  }
  return Object.freeze({
    result: selected,
    branch: prepared.branch,
    deepHead: prepared.deepHead,
    delivery: prepared.delivery
  });
}

function prepareComposition(
  input: FineAssessmentSelectionBoundaryInput,
  capturedScoreFidelity: CapturedScoreFidelityMode
) {
  const packetCandidates = restoreCapturedPacketCandidates(input);
  const candidates = packetCandidates ?? input.ordered_candidates;
  const supplementaryData = restoreSupplementaryData(input.supplementary_data);
  const answerRelevanceScores =
    supplementaryData.answerRelevanceScoresByCandidateKey ?? new Map();
  const deepHead = resolveFineAssessmentDeepHead({
    candidates,
    answerRelevanceScores,
    supplementaryData,
    captureAnswerFeatures:
      capturedScoreFidelity === CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE ||
      input.capture_answer_features
  });
  const branch = resolveFineAssessmentDeliveryBranch({
    answerRelevanceScores
  });
  const delivery = applyDeliverySelection(candidates, deepHead.scores, {
    replacePublicRelevance: branch.replacePublicRelevance
  });
  assertCapturedOrderPolicy(
    input,
    deepHead,
    answerRelevanceScores,
    throwCompositionMismatch
  );
  assertCompositionInputs(input, delivery, deepHead, capturedScoreFidelity);
  const selectionParams = buildCompositionSelectionParams(
    input,
    supplementaryData,
    delivery,
    deepHead,
    createCapturedTokenEstimator(input.token_estimates_by_content),
    packetCandidates
  );
  return Object.freeze({
    branch,
    deepHead,
    delivery,
    selectionParams
  });
}

/** Shared selectFineAssessmentCandidates params for composition and CF. */
export function buildCompositionSelectionParams(
  input: FineAssessmentSelectionBoundaryInput,
  supplementaryData: ReturnType<typeof restoreSupplementaryData>,
  delivery: ReturnType<typeof applyDeliverySelection>,
  deepHead: RecallDeepHeadAssessment,
  tokenEstimator: FineAssessmentSelectionParams["tokenEstimator"] =
    createCapturedTokenEstimator(input.token_estimates_by_content),
  packetCandidates: FineAssessmentSelectionParams["orderedCandidates"] | null =
    restoreCapturedPacketCandidates(input)
): FineAssessmentSelectionParams {
  return {
    orderedCandidates: delivery.orderedCandidates,
    packetCandidates,
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
  deepHead: RecallDeepHeadAssessment,
  capturedScoreFidelity: CapturedScoreFidelityMode
): void {
  assertCandidatePopulation(delivery.orderedCandidates, input.ordered_candidates);
  assertNumberMapEquals(
    delivery.finalRelevanceByCandidateKey,
    input.final_relevance_by_candidate_key
  );
  assertNumberMapEquals(
    delivery.answerRelevanceRankByCandidateKey,
    input.answer_relevance_rank_by_candidate_key
  );
  if (capturedScoreFidelity === CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE) return;
  assertCandidateOrder(delivery.orderedCandidates, input.ordered_candidates);
  assertNumberMapEquals(
    delivery.rankByCandidateKey,
    input.rank_by_candidate_key
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

function assertCandidatePopulation(
  actual: ReturnType<typeof applyDeliverySelection>["orderedCandidates"],
  captured: FineAssessmentSelectionBoundaryInput["ordered_candidates"]
): void {
  if (actual.length !== captured.length) throwCompositionMismatch();
  const capturedKeys = new Set(captured.map((candidate) =>
    candidate.fusion.candidate_key
  ));
  if (capturedKeys.size !== captured.length) throwCompositionMismatch();
  for (const candidate of actual) {
    if (!capturedKeys.has(candidate.fusion.candidate_key)) {
      throwCompositionMismatch();
    }
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

function resolveCapturedScoreFidelity(
  options: SelectionCompositionOptions
): CapturedScoreFidelityMode {
  const mode = options.capturedScoreFidelity ?? CAPTURED_SCORE_FIDELITY_ASSERT;
  if (
    mode === CAPTURED_SCORE_FIDELITY_ASSERT ||
    mode === CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE
  ) {
    return mode;
  }
  throw new Error(`captured score fidelity mode is not supported: ${String(mode)}`);
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
