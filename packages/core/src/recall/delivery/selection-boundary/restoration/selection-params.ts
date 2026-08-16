import { createHash } from "node:crypto";
import {
  makeTokenEstimator,
  type RecallSupplementaryData,
  type TokenEstimator
} from "../../../runtime/recall-service-types.js";
import type { FineAssessmentSelectionParams } from
  "../../fine-assessment-selection.js";
import type {
  FineAssessmentSelectionBoundaryInput,
  SelectionBoundaryNumberMap,
  SerializedRecallSupplementaryData
} from "../selection-boundary-types.js";
import { restoreSemanticActivations } from
  "../validation/evidence-semantic-receipt.js";
import { throwSelectionBoundaryFidelityMismatch } from
  "../validation/fidelity-error.js";
import { restoreCapturedPacketCandidates } from
  "../validation/packet-order.js";

export function restoreSelectionParams(
  input: FineAssessmentSelectionBoundaryInput
): FineAssessmentSelectionParams {
  return {
    orderedCandidates: input.ordered_candidates,
    packetCandidates: restoreCapturedPacketCandidates(input),
    config: input.config,
    supplementaryData: restoreSupplementaryData(input.supplementary_data),
    tokenEstimator: createCapturedTokenEstimator(
      input.token_estimates_by_content
    ),
    generation_id: requireRestoredPin(input.generation_id, "generation_id"),
    condition_digest: requireRestoredPin(input.condition_digest, "condition_digest"),
    rankByCandidateKey: new Map(input.rank_by_candidate_key),
    ...(input.final_relevance_by_candidate_key === undefined ? {} : {
      finalRelevanceByCandidateKey: new Map(
        input.final_relevance_by_candidate_key
      )
    }),
    ...(input.coverage_relevance_by_candidate_key === undefined ? {} : {
      coverageRelevanceByCandidateKey: new Map(
        input.coverage_relevance_by_candidate_key
      )
    }),
    ...(input.coverage_relevance_upper_bound === undefined ? {} : {
      coverageRelevanceUpperBound: input.coverage_relevance_upper_bound
    }),
    ...(input.coverage_objective_config === undefined ? {} : {
      coverageObjectiveConfig: input.coverage_objective_config
    }),
    ...(input.answer_relevance_rank_by_candidate_key === undefined ? {} : {
      answerRelevanceRankByCandidateKey: new Map(
        input.answer_relevance_rank_by_candidate_key
      )
    }),
    ...(input.capture_answer_features === undefined ? {} : {
      captureAnswerFeatures: input.capture_answer_features
    }),
    ...(input.deep_head_trace_by_candidate_key === undefined ? {} : {
      deepHeadTraceByCandidateKey: new Map(
        input.deep_head_trace_by_candidate_key
      )
    })
  };
}

function requireRestoredPin(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0 || value === "unspecified") {
    throw new Error(`Select_Gamma requires a pinned ${label}`);
  }
  return value;
}

export function restoreSupplementaryData(
  data: SerializedRecallSupplementaryData
): RecallSupplementaryData {
  const {
    evidenceSemanticActivationsByCandidateKey,
    openSemanticFactorCandidateActivationsByCandidateKey,
    evidenceSemanticScoresByCandidateKey: _evidenceSemanticScoresByCandidateKey,
    evidenceSemanticWinnersByCandidateKey,
    answerRelevanceScoresByCandidateKey,
    routingKeysByOwnerIdentity,
    keyActivationByOwnerIdentity,
    ...plainData
  } = data;
  return {
    ...plainData,
    evidenceSemanticActivationsByCandidateKey: restoreSemanticActivations(
      evidenceSemanticActivationsByCandidateKey,
      evidenceSemanticWinnersByCandidateKey
    ),
    ...(openSemanticFactorCandidateActivationsByCandidateKey === undefined ? {} : {
      openSemanticFactorCandidateActivationsByCandidateKey: new Map(
        openSemanticFactorCandidateActivationsByCandidateKey
      )
    }),
    ...(answerRelevanceScoresByCandidateKey === undefined ? {} : {
      answerRelevanceScoresByCandidateKey: new Map(
        answerRelevanceScoresByCandidateKey
      )
    }),
    ...(routingKeysByOwnerIdentity === undefined ? {} : {
      routingKeysByOwnerIdentity: new Map(routingKeysByOwnerIdentity)
    }),
    ...(keyActivationByOwnerIdentity === undefined ? {} : {
      keyActivationByOwnerIdentity: new Map(keyActivationByOwnerIdentity)
    })
  };
}

export function createCapturedTokenEstimator(
  entries: SelectionBoundaryNumberMap,
  options: Readonly<{
    readonly onMiss?: "fail" | "compute";
    readonly wrapIdentity?: (run: () => void) => void;
  }> = {}
): FineAssessmentSelectionParams["tokenEstimator"] {
  const tokenEstimates = new Map(entries);
  if (options.onMiss === "compute") {
    return createComputingCapturedTokenEstimator(
      tokenEstimates,
      options.wrapIdentity ?? ((run) => run())
    );
  }
  return createFailClosedCapturedTokenEstimator(tokenEstimates);
}

function createFailClosedCapturedTokenEstimator(
  tokenEstimates: ReadonlyMap<string, number>
): FineAssessmentSelectionParams["tokenEstimator"] {
  return {
    estimate: (content) => {
      const estimate = tokenEstimates.get(content);
      if (estimate === undefined) {
        throwSelectionBoundaryFidelityMismatch(
          missingTokenEstimateDetail(content, tokenEstimates.size)
        );
      }
      return estimate;
    }
  };
}

// Live reorder can admit captured candidates the original walk never
// estimated; compute is the same provider-free function as live capture.
function createComputingCapturedTokenEstimator(
  tokenEstimates: ReadonlyMap<string, number>,
  wrapIdentity: (run: () => void) => void
): FineAssessmentSelectionParams["tokenEstimator"] {
  const liveCompute = makeTokenEstimator();
  wrapIdentity(() =>
    assertCapturedEstimatesMatchLiveCompute(tokenEstimates, liveCompute)
  );
  return {
    estimate: (content) => {
      const captured = tokenEstimates.get(content);
      if (captured !== undefined) return captured;
      return liveCompute.estimate(content);
    }
  };
}

function assertCapturedEstimatesMatchLiveCompute(
  tokenEstimates: ReadonlyMap<string, number>,
  liveCompute: TokenEstimator
): void {
  for (const [content, captured] of tokenEstimates) {
    const computed = liveCompute.estimate(content);
    if (captured !== computed) {
      throwSelectionBoundaryFidelityMismatch(
        capturedTokenEstimateIdentityDetail(content, captured, computed)
      );
    }
  }
}

// Content is hashed, never echoed, so memory text cannot leak into gate output.
function missingTokenEstimateDetail(
  content: string,
  capturedContents: number
): string {
  return "captured token estimate missing: expected " +
    `token_estimates_by_content entry for content sha256:${hashContent(content)} ` +
    `(chars=${content.length}), actual absent among ` +
    `${capturedContents} captured contents`;
}

function capturedTokenEstimateIdentityDetail(
  content: string,
  captured: number,
  computed: number
): string {
  return "captured token estimate disagrees with live compute: " +
    `content sha256:${hashContent(content)} (chars=${content.length}), ` +
    `captured=${captured}, live_compute=${computed}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
