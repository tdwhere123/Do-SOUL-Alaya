import type { BenchRecallDiagnostics } from "../../../harness/recall/recall-diagnostics-schema.js";
import type { OpenSemanticFactorArchive } from "./field/open-semantic-factor-archive.js";
import type {
  BenchEmbeddingProviderState, CandidateDiagnostic, CandidateIdentityObservation,
  DiagnosticAnswerShapePlan, DiagnosticQueryProbes, FineAssessmentPrunedCandidateDiagnostic,
  LongMemEvalGraphExpansionPlaneCountPerEdgeType, LongMemEvalGraphExpansionPlaneCountPerHop,
  LongMemEvalPhaseLatencyMs
} from "./diagnostics-types.js";

export interface NarrowRecallDiagnostics {
  readonly keys: readonly string[];
  readonly rankingAuthority: "prefix_sk" | "select_gamma" | null;
  readonly captureReceipt: NonNullable<BenchRecallDiagnostics["capture_receipt"]> | null;
  readonly queryProbes: DiagnosticQueryProbes | null;
  readonly retrievalFieldCaptures: NonNullable<BenchRecallDiagnostics["retrieval_field_captures"]> | null;
  readonly retrievalFieldRefinementReceipts: NonNullable<BenchRecallDiagnostics["retrieval_field_refinement_receipts"]> | null;
  readonly fieldRefinementStopCertificate: NonNullable<BenchRecallDiagnostics["field_refinement_stop_certificate"]> | null;
  readonly queryCondition: NonNullable<BenchRecallDiagnostics["query_condition"]> | null;
  readonly queryEntityExtraction: NonNullable<BenchRecallDiagnostics["query_entity_extraction"]> | null;
  readonly queryFactFrameExtraction: NonNullable<BenchRecallDiagnostics["query_fact_frame_extraction"]> | null;
  readonly queryOpenSemanticFactorFormation: NonNullable<BenchRecallDiagnostics["query_open_semantic_factor_formation"]> | null;
  readonly queryOpenSemanticFactorCompletenessReceipt: NonNullable<BenchRecallDiagnostics["query_open_semantic_factor_completeness_receipt"]> | null;
  readonly openSemanticFactorCompatibilityTrace: NonNullable<BenchRecallDiagnostics["open_semantic_factor_compatibility_trace"]> | null;
  readonly openSemanticFactorComposition: NonNullable<BenchRecallDiagnostics["open_semantic_factor_composition"]> | null;
  readonly openSemanticFactorActivation: NonNullable<BenchRecallDiagnostics["open_semantic_factor_activation"]> | null;
  readonly kindConstraintAlignment: NonNullable<BenchRecallDiagnostics["kind_constraint_alignment"]> | null;
  readonly openSemanticFactorArchive: OpenSemanticFactorArchive | null;
  readonly answerShapePlan: DiagnosticAnswerShapePlan | null;
  readonly querySoughtFacets: readonly string[] | null;
  readonly candidatePoolComplete: boolean;
  readonly candidatePoolCount: number | null;
  readonly finePrunedCount: number | null;
  readonly fineAssessmentPrunedCandidates: readonly FineAssessmentPrunedCandidateDiagnostic[];
  readonly fineAssessmentPrunedByObjectIdentity: ReadonlyMap<string, FineAssessmentPrunedCandidateDiagnostic>;
  readonly fineAssessmentPrunedObjectIds: ReadonlySet<string>;
  readonly candidatesByObjectId: ReadonlyMap<string, CandidateDiagnostic>;
  readonly candidatesByObjectIdentity: ReadonlyMap<string, CandidateDiagnostic>;
  readonly candidatesByCandidateKey: ReadonlyMap<string, CandidateDiagnostic>;
  readonly candidateIdentityObservations: readonly CandidateIdentityObservation[];
  readonly providerState: BenchEmbeddingProviderState;
  readonly providerDegradationReason: string | null;
  readonly embeddingWorkspaceScannedCount: number | null;
  readonly embeddingWorkspaceTruncated: boolean | null;
  readonly embeddingWorkspaceProviderKind: string | null;
  readonly embeddingWorkspaceModelId: string | null;
  readonly embeddingWorkspaceSchemaVersion: number | null;
  readonly answerRerankStatus: BenchRecallDiagnostics["answer_rerank_status"] | null;
  readonly answerRerankExpectedCount: number | null;
  readonly answerRerankScoredCount: number | null;
  readonly answerRerankFailureClass: BenchRecallDiagnostics["answer_rerank_failure_class"] | null;
  readonly evidenceEmbeddingStatus: BenchRecallDiagnostics["evidence_embedding_status"] | null;
  readonly evidenceEmbeddingExpectedCount: number | null;
  readonly evidenceEmbeddingScoredCount: number | null;
  readonly evidenceEmbeddingInferenceCalls: number | null;
  readonly evidenceEmbeddingLatencyMs: number | null;
  readonly evidenceEmbeddingFailureClass: BenchRecallDiagnostics["evidence_embedding_failure_class"] | null;
  readonly evidenceEmbeddingSelectionReceipt: BenchRecallDiagnostics["evidence_embedding_selection_receipt"] | null;
  readonly packetPlanTrace: BenchRecallDiagnostics["packet_plan_trace"] | null;
  readonly lexicalBoundProofs: NonNullable<BenchRecallDiagnostics["lexical_bound_proofs"]> | null;
  readonly candidatePropositionProvenance:
    NonNullable<BenchRecallDiagnostics["candidate_proposition_provenance"]> | null;
  readonly graphExpansionPlaneCountPerHop: LongMemEvalGraphExpansionPlaneCountPerHop;
  readonly graphExpansionPlaneCountPerEdgeType: Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType>;
  readonly phaseLatencyMs: LongMemEvalPhaseLatencyMs | null;
}
