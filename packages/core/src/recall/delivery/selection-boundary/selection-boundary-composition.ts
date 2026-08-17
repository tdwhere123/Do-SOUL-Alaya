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
import { buildRecallCandidateDedupeKey } from
  "../../runtime/recall-service-helpers.js";
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
import {
  assertCapturedVsLive,
  CAPTURED_SCORE_FIDELITY_ASSERT,
  CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
  type CapturedScoreFidelityMode
} from "./validation/replay-identity-contract.js";

export const SELECTION_COMPOSITION_FIDELITY_MISMATCH =
  "selection composition fidelity mismatch";

export {
  CAPTURED_SCORE_FIDELITY_ASSERT,
  CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE,
  type CapturedScoreFidelityMode
};

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
 * recompute-live frees captured-vs-live output identity; input identity stays closed.
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
    selectionBoundaryObserver: (capture) => {
      pending = capture;
      return undefined;
    }
  });
  assertCapturedVsLive(capturedScoreFidelity, "expected_membership", () => {
    assertCompositionExpected(boundary, selected, pending?.preProjection);
  });
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
  assertRecomputeLiveFeatureCapture(input, capturedScoreFidelity);
  const packetCandidates = restoreCapturedPacketCandidates(input);
  const candidates = packetCandidates ?? input.ordered_candidates;
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
  assertCapturedVsLive(capturedScoreFidelity, "captured_order_policy", () => {
    assertCapturedOrderPolicy(
      input,
      deepHead,
      answerRelevanceScores,
      () => throwCompositionMismatch("captured_order_policy")
    );
  });
  assertCompositionInputs(input, delivery, deepHead, capturedScoreFidelity);
  const selectionParams = buildCompositionSelectionParams(
    input,
    supplementaryData,
    delivery,
    deepHead,
    resolveCompositionTokenEstimator(input, capturedScoreFidelity),
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
    workspace_id: input.workspace_id,
    orderedCandidates: delivery.orderedCandidates,
    packetCandidates,
    config: input.config,
    supplementaryData,
    tokenEstimator,
    rankByCandidateKey: delivery.rankByCandidateKey,
    finalRelevanceByCandidateKey: delivery.finalRelevanceByCandidateKey,
    coverageRelevanceByCandidateKey: deepHead.scores,
    coverageRelevanceUpperBound: deepHead.relevanceUpperBoundReceipt,
    answerRelevanceRankByCandidateKey:
      delivery.answerRelevanceRankByCandidateKey,
    ...(input.capture_answer_features === undefined ? {} : {
      captureAnswerFeatures: input.capture_answer_features
    }),
    capturePacketPlanTrace: true,
    deepHeadTraceByCandidateKey: deepHead.traceByCandidateKey,
    generation_id: requireCapturedPin(input.generation_id, "generation_id"),
    condition_digest: requireCapturedPin(input.condition_digest, "condition_digest")
  };
}

function requireCapturedPin(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0 || value === "unspecified") {
    throw new Error(`Select_Gamma requires a pinned ${label}`);
  }
  return value;
}

function assertCompositionInputs(
  input: FineAssessmentSelectionBoundaryInput,
  delivery: ReturnType<typeof applyDeliverySelection>,
  deepHead: RecallDeepHeadAssessment,
  capturedScoreFidelity: CapturedScoreFidelityMode
): void {
  assertCompositionDeliveryInputs(input, delivery, capturedScoreFidelity);
  assertCompositionDeepHeadInputs(input, deepHead, capturedScoreFidelity);
}

function assertCompositionDeliveryInputs(
  input: FineAssessmentSelectionBoundaryInput,
  delivery: ReturnType<typeof applyDeliverySelection>,
  capturedScoreFidelity: CapturedScoreFidelityMode
): void {
  assertCapturedVsLive(capturedScoreFidelity, "candidate_population", () => {
    assertCandidatePopulation(delivery.orderedCandidates, input.ordered_candidates);
  });
  assertCapturedVsLive(capturedScoreFidelity, "final_relevance", () => {
    assertNumberMapEquals(
      delivery.finalRelevanceByCandidateKey,
      input.final_relevance_by_candidate_key,
      "final_relevance"
    );
  });
  assertCapturedVsLive(capturedScoreFidelity, "answer_relevance_rank", () => {
    assertNumberMapEquals(
      delivery.answerRelevanceRankByCandidateKey,
      input.answer_relevance_rank_by_candidate_key,
      "answer_relevance_rank"
    );
  });
  assertCapturedVsLive(capturedScoreFidelity, "candidate_order", () => {
    assertCandidateOrder(delivery.orderedCandidates, input.ordered_candidates);
  });
  assertCapturedVsLive(capturedScoreFidelity, "delivery_rank", () => {
    assertNumberMapEquals(
      delivery.rankByCandidateKey,
      input.rank_by_candidate_key,
      "delivery_rank"
    );
  });
}

function assertCompositionDeepHeadInputs(
  input: FineAssessmentSelectionBoundaryInput,
  deepHead: RecallDeepHeadAssessment,
  capturedScoreFidelity: CapturedScoreFidelityMode
): void {
  assertCapturedVsLive(capturedScoreFidelity, "coverage_relevance", () => {
    assertNumberMapEquals(
      deepHead.scores,
      input.coverage_relevance_by_candidate_key,
      "coverage_relevance"
    );
  });
  assertCapturedVsLive(
    capturedScoreFidelity,
    "coverage_relevance_upper_bound",
    () => {
      if (selectionBoundaryJsonSha256(deepHead.relevanceUpperBoundReceipt) !==
          selectionBoundaryJsonSha256(
            input.coverage_relevance_upper_bound ?? null
          )) {
        throwCompositionMismatch("coverage_relevance_upper_bound");
      }
    }
  );
  assertCapturedVsLive(capturedScoreFidelity, "deep_head_traces", () => {
    assertDeepHeadTraces(
      deepHead.traceByCandidateKey,
      input.deep_head_trace_by_candidate_key,
      input.capture_answer_features === true
    );
  });
}

function assertCompositionExpected(
  boundary: FineAssessmentSelectionBoundaryCase,
  selected: FineAssessmentSelectionResult,
  preProjection: FineAssessmentPreProjectionCapture | undefined
): void {
  const packetConsensus = selected.packetPlanObservation;
  if (packetConsensus === undefined) {
    throwCompositionMismatch("packet_plan_observation");
  }
  if (preProjection === undefined) {
    throwCompositionMismatch("pre_projection");
  }
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
    throwCompositionMismatch("expected_membership");
  }
}

function assertCandidatePopulation(
  actual: ReturnType<typeof applyDeliverySelection>["orderedCandidates"],
  captured: FineAssessmentSelectionBoundaryInput["ordered_candidates"]
): void {
  if (actual.length !== captured.length) {
    throwCompositionMismatch("candidate_population");
  }
  const capturedKeys = new Set(captured.map((candidate) =>
    candidate.fusion.candidate_key
  ));
  if (capturedKeys.size !== captured.length) {
    throwCompositionMismatch("candidate_population");
  }
  for (const candidate of actual) {
    // Live identity, not a spoofable fusion.candidate_key on the same objects.
    if (!capturedKeys.has(buildRecallCandidateDedupeKey(candidate))) {
      throwCompositionMismatch("candidate_population");
    }
  }
}

function assertCandidateOrder(
  actual: ReturnType<typeof applyDeliverySelection>["orderedCandidates"],
  captured: FineAssessmentSelectionBoundaryInput["ordered_candidates"]
): void {
  if (actual.length !== captured.length) {
    throwCompositionMismatch("candidate_order");
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (
      actual[index]!.fusion.candidate_key !==
      captured[index]!.fusion.candidate_key
    ) {
      throwCompositionMismatch("candidate_order");
    }
  }
}

function resolveCompositionTokenEstimator(
  input: FineAssessmentSelectionBoundaryInput,
  capturedScoreFidelity: CapturedScoreFidelityMode
): FineAssessmentSelectionParams["tokenEstimator"] {
  // Token *function* identity stays fail-closed; miss compute is not an output skip.
  return createCapturedTokenEstimator(input.token_estimates_by_content, {
    onMiss: capturedScoreFidelity === CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE
      ? "compute"
      : "fail",
    wrapIdentity: (run) =>
      assertCapturedVsLive(capturedScoreFidelity, "token_function", run)
  });
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

function assertRecomputeLiveFeatureCapture(
  input: FineAssessmentSelectionBoundaryInput,
  capturedScoreFidelity: CapturedScoreFidelityMode
): void {
  if (capturedScoreFidelity !== CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE) return;
  if (input.capture_answer_features === true) return;
  throw new Error("recompute_live requires capture_answer_features");
}

function assertNumberMapEquals(
  actual: ReadonlyMap<string, number>,
  captured: SelectionBoundaryNumberMap | undefined,
  assertName: string
): void {
  const entries = captured ?? [];
  if (actual.size !== entries.length) throwCompositionMismatch(assertName);
  for (const [key, value] of entries) {
    if (actual.get(key) !== value) throwCompositionMismatch(assertName);
  }
}

function assertDeepHeadTraces(
  actual: ReadonlyMap<string, RecallDeepHeadTrace>,
  captured: readonly (readonly [string, RecallDeepHeadTrace])[] | undefined,
  captureAnswerFeatures: boolean
): void {
  if (!captureAnswerFeatures) {
    if (actual.size !== 0) throwCompositionMismatch("deep_head_traces");
    if (captured !== undefined && captured.length > 0) {
      throwCompositionMismatch("deep_head_traces");
    }
    return;
  }
  if (captured === undefined || actual.size !== captured.length) {
    throwCompositionMismatch("deep_head_traces");
  }
  for (const [key, value] of captured) {
    const recomputed = actual.get(key);
    if (recomputed === undefined) throwCompositionMismatch("deep_head_traces");
    if (
      selectionBoundaryJsonSha256(recomputed) !==
      selectionBoundaryJsonSha256(value)
    ) {
      throwCompositionMismatch("deep_head_traces");
    }
  }
}

function throwCompositionMismatch(assertName: string): never {
  throw new Error(`${SELECTION_COMPOSITION_FIDELITY_MISMATCH}: ${assertName}`);
}
