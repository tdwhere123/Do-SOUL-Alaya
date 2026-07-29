import type { MemoryDimension as MemoryDimensionType, RecallCandidate, RecallPolicy, RecallScoreFactors } from "@do-soul/alaya-protocol";
import type { CoarseRecallCandidate, RecallCandidateDiagnostic, RecallCandidateDropReason, RecallFusionBreakdown, RecallSupplementaryData, TokenEstimator } from "../../runtime/recall-service-types.js";
import type { RecallAnswerSupportObservation } from "../../query/recall-answer-support-observation.js";
import type { RecallCandidateAnswerSupport } from "../../query/recall-candidate-answer-support.js";
import type { RecallDeepHeadTrace } from "../../rerank/deep-head.js";
import { materializeFinalPacket } from "../final-order/final-packet-order.js";
import type { RecallPacketPlanObservation } from "../packet-plan/packet-plan-trace.js";
import type { FineAssessmentSelectionBoundaryPendingCapture } from "../selection-boundary/selection-boundary-capture.js";

export type FineAssessmentCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
  readonly fusion: RecallFusionBreakdown;
}>;

export interface FineAssessmentAccumulator {
  readonly selected: RecallCandidate[];
  readonly diagnostics: RecallCandidateDiagnostic[];
  readonly admission: FineAssessmentAdmissionState;
}

export interface FineAssessmentAdmissionState {
  readonly seenObjects: Set<string>;
  readonly perDimensionCounts: Map<MemoryDimensionType, number>;
  selectedCount: number;
  totalTokens: number;
}

export interface FineAssessmentSelectionContext {
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
  readonly finalRelevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly answerRelevanceRankByCandidateKey: ReadonlyMap<string, number>;
  readonly answerRerankedCandidateKeys: ReadonlySet<string>;
  readonly captureAnswerFeatures: boolean;
  readonly answerSupportByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallCandidateAnswerSupport>
  >;
  readonly answerSupportObservationsByCandidateKey: ReadonlyMap<
    string,
    readonly Readonly<RecallAnswerSupportObservation>[]
  >;
  readonly deepHeadTraceByCandidateKey: ReadonlyMap<string, RecallDeepHeadTrace>;
  readonly coverageMarginalGainByCandidateKey: Map<string, number>;
  readonly tokenEstimateByCandidateKey: Map<string, number>;
}

export interface FineAssessmentAdmission {
  readonly droppedReason: RecallCandidateDropReason | null;
  readonly tokenEstimate: number | null;
}

export type FineAssessmentSelectionParams = Readonly<{
  readonly orderedCandidates: readonly FineAssessmentCandidate[];
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
  readonly finalRelevanceByCandidateKey?: ReadonlyMap<string, number>;
  /** Packing relevance; defaults to finalRelevance. Deep-head scores when public scalar stays fused. */
  readonly coverageRelevanceByCandidateKey?: ReadonlyMap<string, number>;
  readonly finalOrderAfterCoverage?: "coverage" | "public_relevance" | "delivery_rank";
  readonly maxHeadDropAfterCoverage?: number;
  readonly answerRelevanceRankByCandidateKey?: ReadonlyMap<string, number>;
  readonly captureAnswerFeatures?: boolean;
  readonly capturePacketPlanTrace?: boolean;
  readonly deepHeadTraceByCandidateKey?: ReadonlyMap<string, RecallDeepHeadTrace>;
  readonly selectionBoundaryObserver?: (
    boundary: FineAssessmentSelectionBoundaryPendingCapture
  ) => undefined;
}>;

export type FineAssessmentSelectionResult = ReturnType<typeof materializeFinalPacket> & Readonly<{
  readonly packetPlanObservation?: Readonly<RecallPacketPlanObservation>;
}>;
