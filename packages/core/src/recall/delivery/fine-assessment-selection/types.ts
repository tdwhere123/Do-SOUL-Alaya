import type { MemoryDimension as MemoryDimensionType, RecallCandidate, RecallPolicy, RecallScoreFactors } from "@do-soul/alaya-protocol";
import type { CoarseRecallCandidate, RecallCandidateDiagnostic, RecallCandidateDropReason, RecallFusionBreakdown, RecallSupplementaryData, TokenEstimator } from "../../runtime/recall-service-types.js";
import type { RecallAnswerSupportObservation } from "../../query/recall-answer-support-observation.js";
import type { RecallCandidateAnswerSupport } from "../../query/recall-candidate-answer-support.js";
import type { RecallAnswerShapePlan } from "../../query/recall-answer-shape-plan.js";
import type { RecallDeepHeadTrace } from "../../rerank/deep-head.js";
import { materializeFinalPacket } from "../final-order/final-packet-order.js";
import type { RecallPacketPlanObservation } from "../packet-plan/packet-plan-observation.js";
import type { FineAssessmentSelectionBoundaryPendingCapture } from "../selection-boundary/selection-boundary-capture.js";
import type { CoverageSelectionObjectiveReceipt } from "../coverage-selection.js";
import type { CoverageSelectionOperatorConfig } from
  "../../field/facility/selection-objective.js";
import type { RecallFieldRefinementStopCertificate } from
  "../../field/refinement/field-refinement-stop-certificate.js";
import type { RecallRelevanceUpperBoundReceipt } from
  "../../rerank/relevance-upper-bound-receipt.js";
import type { FineAssessmentOrderSequence } from "./order-sequence.js";

export type FineAssessmentCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
  readonly fusion: RecallFusionBreakdown;
}>;

export interface FineAssessmentAccumulator {
  readonly selected: RecallCandidate[];
  readonly diagnostics: RecallCandidateDiagnostic[];
  readonly admission: FineAssessmentAdmissionState;
  readonly admissionReceipts?: FineAssessmentAdmissionReceipt[];
}

export interface FineAssessmentAdmissionState {
  readonly seenObjects: Set<string>;
  readonly retainedCandidateKeyByObjectKey?: Map<string, string>;
  readonly perDimensionCounts: Map<MemoryDimensionType, number>;
  selectedCount: number;
  totalTokens: number;
}

export type FineAssessmentAdmissionReceipt =
  | Readonly<{
      readonly kind: "retained";
      readonly selected_count_before: number;
      readonly token_total_before: number;
      readonly token_estimate: number;
    }>
  | Readonly<{
      readonly kind: "duplicate";
      readonly retained_candidate_key: string;
    }>
  | Readonly<{
      readonly kind: "dimension_limit";
      readonly dimension: string;
      readonly accepted_before: number;
      readonly limit: number;
    }>
  | Readonly<{
      readonly kind: "max_entries";
      readonly accepted_before: number;
      readonly limit: number;
    }>
  | Readonly<{
      readonly kind: "max_total_tokens";
      readonly token_total_before: number;
      readonly token_estimate: number;
      readonly limit: number;
    }>;

export interface FineAssessmentSelectionContext {
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
  readonly finalRelevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly coverageRelevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly coverageRelevanceUpperBound:
    Readonly<RecallRelevanceUpperBoundReceipt> | null;
  readonly answerRelevanceRankByCandidateKey: ReadonlyMap<string, number>;
  readonly captureAnswerFeatures: boolean;
  readonly answerShapePlan: Readonly<RecallAnswerShapePlan>;
  readonly supportsSingleSemanticLeader: boolean;
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
  readonly coverageObjectiveConfig?: CoverageSelectionOperatorConfig;
}

export interface FineAssessmentAdmission {
  readonly droppedReason: RecallCandidateDropReason | null;
  readonly tokenEstimate: number | null;
  readonly receipt?: FineAssessmentAdmissionReceipt;
}

export type FineAssessmentSelectionParams = Readonly<{
  readonly orderedCandidates: readonly FineAssessmentCandidate[];
  /** Null means a prior boundary did not capture the pre-delivery packet order. */
  readonly packetCandidates?: readonly FineAssessmentCandidate[] | null;
  readonly generation_id?: string;
  readonly condition_digest?: string;
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
  readonly finalRelevanceByCandidateKey?: ReadonlyMap<string, number>;
  /** Packing relevance; defaults to finalRelevance. Deep-head scores when public scalar stays fused. */
  readonly coverageRelevanceByCandidateKey?: ReadonlyMap<string, number>;
  readonly coverageRelevanceUpperBound?:
    Readonly<RecallRelevanceUpperBoundReceipt> | null;
  readonly coverageObjectiveConfig?: CoverageSelectionOperatorConfig;
  readonly answerRelevanceRankByCandidateKey?: ReadonlyMap<string, number>;
  readonly captureAnswerFeatures?: boolean;
  readonly answerShapePlan?: Readonly<RecallAnswerShapePlan>;
  readonly capturePacketPlanTrace?: boolean;
  readonly deepHeadTraceByCandidateKey?: ReadonlyMap<string, RecallDeepHeadTrace>;
  readonly selectionBoundaryObserver?: (
    boundary: FineAssessmentSelectionBoundaryPendingCapture
  ) => undefined;
}>;

export type FineAssessmentSelectionResult = ReturnType<typeof materializeFinalPacket> & Readonly<{
  readonly coverageSelectionObjective: CoverageSelectionObjectiveReceipt;
  readonly fieldRefinementStopCertificate?:
    Readonly<RecallFieldRefinementStopCertificate>;
  readonly packetPlanObservation?: Readonly<RecallPacketPlanObservation>;
  readonly orderSequence: FineAssessmentOrderSequence;
}>;
