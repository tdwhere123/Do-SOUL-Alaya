import type { RecallPolicy } from "@do-soul/alaya-protocol";
import type { RecallPacketPlanObservation } from
  "../packet-plan/packet-plan-observation.js";
import type {
  RecallCandidateDropReason,
  RecallEvidenceSemanticActivationReceipt,
  RecallEvidenceSemanticWinnerReceipt,
  RecallSupplementaryData
} from "../../runtime/recall-service-types.js";
import type { RecallDeepHeadTrace } from "../../rerank/deep-head.js";
import type { CoverageSelectionObjectiveReceipt } from "../coverage-selection.js";
import type { CoverageSelectionOperatorConfig } from
  "../../field/facility/selection-objective.js";
import type { RecallFieldRefinementStopCertificate } from
  "../../field/refinement/field-refinement-stop-certificate.js";
import type { RecallRelevanceUpperBoundReceipt } from
  "../../rerank/relevance-upper-bound-receipt.js";
import type {
  FineAssessmentAdmissionReceipt,
  FineAssessmentCandidate
} from "../fine-assessment-selection.js";

export type SelectionBoundaryMap<T> = readonly (
  readonly [key: string, value: T]
)[];

export type SelectionBoundaryNumberMap = SelectionBoundaryMap<number>;

type MapValue<T> = T extends ReadonlyMap<string, infer V> ? V : never;

export type FineAssessmentPreProjectionAction = Readonly<{
  readonly candidate_key: string;
  readonly action: "retain" | "exclude";
  readonly selection_order: number;
  readonly pre_projection_rank: number | null;
  readonly dropped_reason: RecallCandidateDropReason | null;
  readonly witness: FineAssessmentPreProjectionWitness;
}>;

export type FineAssessmentPreProjectionWitness =
  FineAssessmentAdmissionReceipt;

export type FineAssessmentPreProjectionObservation = Readonly<{
  readonly schema_version: 1;
  readonly candidate_keys: readonly string[];
  readonly token_total: number;
  readonly admission_actions: readonly FineAssessmentPreProjectionAction[];
  readonly projection_actions: readonly FineAssessmentProjectionAction[];
  readonly introduced_candidate_keys: readonly string[];
  readonly ordered_subsequence: boolean;
  readonly qualified_ordered_subsequence: boolean;
}>;

export type FineAssessmentPreProjectionCapture = Readonly<{
  readonly schema_version: 1;
  readonly candidate_keys: readonly string[];
  readonly token_total: number;
  readonly admission_actions: readonly FineAssessmentPreProjectionAction[];
}>;

export type FineAssessmentProjectionAction = Readonly<{
  readonly candidate_key: string;
  readonly action: "retain" | "exclude";
  readonly pre_projection_rank: number;
  readonly delivered_rank: number | null;
  readonly qualification: "permitted" | "ineligible";
  readonly reason_code:
    | "stable_order_identity"
    | "unwitnessed_reorder"
    | "unwitnessed_exclusion";
  readonly witness: Readonly<{
    readonly kind: "rank_transition";
    readonly pre_projection_rank: number;
    readonly delivered_rank: number | null;
  }>;
}>;

export type FineAssessmentSelectionBoundaryInput = Readonly<{
  readonly ordered_candidates: readonly FineAssessmentCandidate[];
  readonly packet_candidate_keys?: readonly string[];
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementary_data: SerializedRecallSupplementaryData;
  readonly token_estimates_by_content: SelectionBoundaryNumberMap;
  readonly rank_by_candidate_key: SelectionBoundaryNumberMap;
  readonly final_relevance_by_candidate_key?: SelectionBoundaryNumberMap;
  readonly coverage_relevance_by_candidate_key?: SelectionBoundaryNumberMap;
  readonly coverage_relevance_upper_bound?:
    Readonly<RecallRelevanceUpperBoundReceipt> | null;
  readonly coverage_objective_config?: CoverageSelectionOperatorConfig;
  readonly final_order_after_coverage?: "coverage" | "public_relevance" | "delivery_rank";
  readonly max_head_drop_after_coverage?: number;
  readonly answer_relevance_rank_by_candidate_key?: SelectionBoundaryNumberMap;
  readonly capture_answer_features?: boolean;
  readonly capture_packet_plan_trace?: boolean;
  readonly deep_head_trace_by_candidate_key?: readonly (
    readonly [key: string, value: RecallDeepHeadTrace]
  )[];
}>;

export type SerializedRecallSupplementaryData = Readonly<
  Omit<
    RecallSupplementaryData,
    "evidenceSemanticDocumentsByMemoryId" |
    "evidenceSemanticActivationsByCandidateKey" |
    "openSemanticFactorCandidateActivationsByCandidateKey" |
    "answerRelevanceScoresByCandidateKey" |
    "routingKeysByOwnerIdentity" |
    "keyActivationByOwnerIdentity"
  > & {
    readonly evidenceSemanticActivationsByCandidateKey?: SelectionBoundaryMap<
      Readonly<RecallEvidenceSemanticActivationReceipt>
    >;
    readonly openSemanticFactorCandidateActivationsByCandidateKey?:
      SelectionBoundaryMap<
        Readonly<import("../../field/open-semantic-factors/candidate-attribution.js")
          .OpenSemanticFactorCandidateActivation>
      >;
    /** Legacy selection boundaries are normalized into winner-only receipts. */
    readonly evidenceSemanticScoresByCandidateKey?: SelectionBoundaryNumberMap;
    /** Legacy selection boundaries are normalized into winner-only receipts. */
    readonly evidenceSemanticWinnersByCandidateKey?: SelectionBoundaryMap<
      Readonly<RecallEvidenceSemanticWinnerReceipt>
    >;
    readonly answerRelevanceScoresByCandidateKey?: SelectionBoundaryNumberMap;
    readonly routingKeysByOwnerIdentity?: SelectionBoundaryMap<
      MapValue<RecallSupplementaryData["routingKeysByOwnerIdentity"]>
    >;
    readonly keyActivationByOwnerIdentity?: SelectionBoundaryMap<
      MapValue<RecallSupplementaryData["keyActivationByOwnerIdentity"]>
    >;
  }
>;

export type FineAssessmentSelectionBoundaryExpected = Readonly<{
  readonly coverage_objective?: CoverageSelectionObjectiveReceipt;
  readonly field_refinement_stop_certificate?:
    Readonly<RecallFieldRefinementStopCertificate>;
  readonly candidate_keys: readonly string[];
  readonly drop_tuples: readonly (
    readonly [candidateKey: string, reason: RecallCandidateDropReason | null]
  )[];
  readonly token_totals: Readonly<{ readonly delivered: number }>;
  readonly packet_consensus: Readonly<RecallPacketPlanObservation>;
  readonly visible_result_sha256: `sha256:${string}`;
  readonly pre_projection?: FineAssessmentPreProjectionObservation;
}>;

export type FineAssessmentSelectionBoundaryCase = Readonly<{
  readonly schema_version: 2;
  readonly input: FineAssessmentSelectionBoundaryInput;
  readonly expected: FineAssessmentSelectionBoundaryExpected;
}>;
