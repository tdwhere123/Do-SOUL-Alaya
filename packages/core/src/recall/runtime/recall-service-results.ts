import type {
  AssociativeFactSlot,
  AssociativeFactKeyProjectionForm,
  FtsLaneId,
  ManifestationState,
  MemoryEntry,
  PathAnchorRef,
  RecallCandidate,
  RecallOriginPlane,
  SoulActiveConstraint,
  SoulMemorySearchDegradationReason
} from "@do-soul/alaya-protocol";
import type { SelectedSliceKeyV2 } from "../flood/slice-key-contract.js";
import type { AttributedKeyActivationV1 } from "../flood/attributed-key-activation.js";
import type { RecallFiniteFieldSeal } from "../field/finite-field-seal.js";
import type { RecallQueryFieldAttributionReceipt } from
  "../field/query-attribution/query-field-attribution.js";
import type { SelectGammaSynthesisStatus } from
  "../delivery/select-gamma/synthesis-adapter.js";

import type { RecallAdmissionPlane, RecallDiagnostics, RecallPathExpansionSourceDiagnostic } from "./recall-service-diagnostics.js";

/** Immutable scoring provenance prevents diagnostics from re-querying mutable path state. */
export interface PathInflowEdge {
  /** Optional only for legacy or synthetic callers; PathRelation producers populate these fields. */
  readonly pathId?: string;
  readonly relationKind?: string;
  readonly seedObjectId: string;
  readonly targetObjectId?: string;
  readonly seedAnchor?: Readonly<PathAnchorRef>;
  readonly targetAnchor?: Readonly<PathAnchorRef>;
  readonly pathSourceVersion?: string;
  readonly weight: number;
}

export type RecallPathInflowAvailability =
  | "not_observed"
  | "available"
  | "unavailable"
  | "storage_error";


export interface EvidenceSupportVector {
  readonly source_kind: "evidence_ref";
  readonly source_id: string;
  readonly support: number;
}

export interface RecallEvidenceProjectionMatchReceipt {
  readonly evidence_ref: string;
  readonly projection_kind: "owner" | "assistant_observation" | "fact_key";
  readonly projection_id: number | null;
  readonly normalized_rank: number;
  /** Absent only in legacy traces; live FTS producers bind their source lanes. */
  readonly matched_fts_lanes?: readonly FtsLaneId[];
  readonly fact_key_forms: readonly Readonly<AssociativeFactKeyProjectionForm>[];
  /** Present only for source-grounded Fact-Key projections; absent in legacy traces. */
  readonly fact_slots?: readonly Readonly<AssociativeFactSlot>[];
}

export interface RecallEvidenceSemanticProjectionReceipt {
  readonly projection_id: number | null;
  readonly projection_kind: "owner" | "fact_key";
  readonly matched_fact_key_forms: readonly Readonly<AssociativeFactKeyProjectionForm>[];
  /** Present only for source-grounded Fact-Key projections; absent in legacy traces. */
  readonly fact_slots?: readonly Readonly<AssociativeFactSlot>[];
}

export interface RecallEvidenceSemanticDocument {
  readonly evidenceRef: string;
  readonly documentIdentity: string;
  readonly content: string;
  readonly projection: Readonly<RecallEvidenceSemanticProjectionReceipt>;
}

export interface RecallEvidenceSemanticWinnerReceipt {
  readonly score: number;
  readonly evidenceObjectId: string;
  readonly documentIdentity: string;
  readonly contentHash?: string;
  readonly projection: Readonly<RecallEvidenceSemanticProjectionReceipt> | null;
}

export interface RecallEvidenceSemanticActivationReceipt {
  readonly schema_version: 1;
  readonly operator_id: "evidence_document_max_v1";
  readonly state: "observed";
  readonly score: number;
  readonly winner: Readonly<RecallEvidenceSemanticWinnerReceipt>;
  readonly observations: readonly Readonly<RecallEvidenceSemanticWinnerReceipt>[];
  readonly observation_completeness:
    | "complete"
    | "bounded_candidate_prefix"
    | "winner_only_legacy";
  readonly missing_channel_policy: "no_op";
}

export interface RecallResult {
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly synthesis: SelectGammaSynthesisStatus;
  readonly active_constraints: readonly Readonly<SoulActiveConstraint>[];
  readonly active_constraints_count: number;
  readonly total_scanned: number;
  readonly coarse_filter_count: number;
  readonly fine_assessment_count: number;
  readonly degradation_reason: SoulMemorySearchDegradationReason | null;
  readonly working_projection: null;
  readonly diagnostics?: Readonly<RecallDiagnostics>;
  readonly delivery_path?: "legacy" | "canonical";
  readonly capture_identity?: Readonly<{
    readonly algorithm_id: string;
    readonly version: string;
    readonly digest: string;
  }>;
  readonly ranking_authority?: "prefix_sk" | "select_gamma";
  readonly capture_execution?: Readonly<import("@do-soul/alaya-protocol").CaptureExecution>;
}

export interface RecallSupplementaryData {
  readonly queryProbes: Readonly<import("../query/recall-query-probes.js").RecallQueryProbes>;
  readonly retrievalFieldSeal?: Readonly<RecallFiniteFieldSeal>;
  readonly retrievalFieldRefinementReceipts?: readonly Readonly<
    import("../field/refinement/field-refinement-receipt.js")
      .RecallRetrievalFieldRefinementReceipt
  >[];
  readonly queryFieldAttribution?: Readonly<RecallQueryFieldAttributionReceipt>;
  readonly queryFactFrameExtraction?: Readonly<
    import("../field/query-attribution/query-fact-frame-attribution-producer.js")
      .RecallQueryFactFrameExtractionCapture
  >;
  readonly queryOpenSemanticFactorFormation?: Readonly<
    import("@do-soul/alaya-protocol").OpenSemanticFactorFormationCapture
  >;
  readonly queryOpenSemanticFactorCompletenessReceipt?: Readonly<
    import("@do-soul/alaya-protocol").QueryOsfSemanticCompletenessReceipt
  >;
  readonly semanticFactorFormationsByEvidenceId?: Readonly<Record<
    string,
    Readonly<import("@do-soul/alaya-protocol").OpenSemanticFactorFormationCapture>
  >>;
  readonly factFrameFormationsByEvidenceId?: Readonly<Record<
    string,
    Readonly<import("@do-soul/alaya-protocol").EvidenceFactFrameFormationCapture>
  >>;
  readonly openSemanticFactorCompatibilityTrace?: Readonly<
    import("../field/open-semantic-factors/compatibility-trace.js")
      .OpenSemanticFactorCompatibilityTrace
  >;
  readonly openSemanticFactorComposition?: Readonly<
    import("../field/open-semantic-factors/composition.js")
      .OpenSemanticFactorCompositionReceipt
  >;
  readonly openSemanticFactorActivation?: Readonly<
    import("../field/open-semantic-factors/activation.js")
      .OpenSemanticFactorActivationReceipt
  >;
  readonly kindConstraintAlignment?: Readonly<
    import("../field/kind-projection/alignment.js").KindConstraintAlignmentReceipt
  >;
  readonly openSemanticFactorCandidateActivationsByCandidateKey?: ReadonlyMap<
    string,
    Readonly<import("../field/open-semantic-factors/candidate-attribution.js")
      .OpenSemanticFactorCandidateActivation>
  >;
  readonly queryTimeWindow?: Readonly<import("../scoring/temporal-fusion-scoring.js").QueryTimeWindow>;
  readonly routingKeysByOwnerIdentity?: ReadonlyMap<
    string,
    readonly Readonly<SelectedSliceKeyV2>[]
  >;
  readonly queryRoutingKeys?: readonly Readonly<SelectedSliceKeyV2>[];
  readonly keyActivationByOwnerIdentity?: ReadonlyMap<
    string,
    Readonly<AttributedKeyActivationV1>
  >;
  readonly ftsRanks: Readonly<Record<string, number>>;
  // Trigram-lane normalized rank, surfaced separately from ftsRanks so the
  // trigram_fts fusion stream can read substring / spelling-variant / CJK
  // matches without conflating them with word-level porter/exact ranks.
  readonly trigramFtsRanks: Readonly<Record<string, number>>;
  readonly synthesisFtsRanks: Readonly<Record<string, number>>;
  readonly evidenceFtsRanks: Readonly<Record<string, number>>;
  // Per-ref grain (evidenceFtsRanks aggregates to memory id); absent → lane-count fallback.
  readonly evidenceFtsRanksPerRef?: Readonly<Record<string, number>>;
  readonly evidenceProjectionMatchesByRef: Readonly<Record<
    string,
    readonly Readonly<RecallEvidenceProjectionMatchReceipt>[]
  >>;
  readonly sourceProximityScores: Readonly<Record<string, number>>;
  readonly sourceCohortKeys: Readonly<Record<string, string>>;
  readonly structuralScores: Readonly<Record<string, number>>;
  readonly graphExpansionScores: Readonly<Record<string, number>>;
  // see also: collectEntityDerivedSeeds — per-memory entity_seed plane score
  // produced from the FTS rank of the strongest entity surface that hit.
  readonly entitySeedScores: Readonly<Record<string, number>>;
  readonly pathExpansionScores: Readonly<Record<string, number>>;
  // Conformant-only: target object_id → inflow edges (seed object_id + learned-edge weight π),
  // the adjacency the path FLOOD sums over. Absent (flag-off) → no flood.
  readonly pathInflowByTarget?: Readonly<Record<string, readonly PathInflowEdge[]>>;
  /** Capture provenance for distinguishing an empty path set from a failed path read. */
  readonly pathInflowAvailability?: RecallPathInflowAvailability;
  // Active sign-aware suppression receipts keyed by target memory id. They
  // remain diagnostic because family-max RRF is the sole R_obj authority.
  readonly pathSuppressionScores: Readonly<Record<string, number>>;
  // Key presence means query embedding was observed; finite zero is distinct from cold absence.
  readonly embeddingSimilarityScores: Readonly<Record<string, number>>;
  readonly embeddingObservationDomain?: Readonly<{
    readonly provider_kind: string;
    readonly model_id: string;
    readonly dimensions: number;
    readonly schema_version: number;
  }>;
  readonly embeddingContentHashByObjectId?: Readonly<Record<string, string>>;
  // Transient evidence previews are keyed by full candidate identity so a
  // colliding memory object id cannot inherit their semantic signal.
  readonly evidenceSemanticActivationsByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallEvidenceSemanticActivationReceipt>
  >;
  // Optional final query-to-candidate relevance owned by a local reranker.
  // Candidate-key identity preserves distinct provenance projections.
  readonly answerRelevanceScoresByCandidateKey?: ReadonlyMap<string, number>;
  readonly graphSupportCounts: Readonly<Record<string, number>>;
  readonly evidenceSupportVectorsByMemoryId?: Readonly<Record<string, readonly EvidenceSupportVector[]>>;
  readonly budgetPenaltyFactor: number;
  readonly plasticityFactors: Readonly<Record<string, number>>;
  readonly graphAndPathColdScore: number;
  readonly recallsEdgeCount: number;
  readonly weightTransferAmount: number;
  // Evidence capsule gist keyed by memory id — coverage delivery identity + diagnostics.
  readonly evidenceGistsByMemoryId: Readonly<Record<string, string>>;
  readonly evidenceSemanticDocumentsByMemoryId?: Readonly<Record<
    string,
    readonly Readonly<RecallEvidenceSemanticDocument>[]
  >>;
  readonly verifiedUserAssertionContextsByMemoryId?: Readonly<
    Record<
      string,
      Readonly<
        import("../query/recall-user-assertion-context.js").RecallVerifiedUserAssertionContext
      >
    >
  >;
  // invariant: governance ceiling on recall manifestation, keyed by
  // memory_entry.object_id. Derived from each candidate's inbound
  // recall-eligible PathRelations (isPathRecallEligible) via
  // memoryGovernanceCeiling. The fine-assess clamp lowers a candidate's
  // strength tier to this ceiling (never elevates). A memory with no governing
  // inbound path is ABSENT from this map; the clamp site defaults it to
  // full_eligible (unrestricted). see also: path-manifestation-policy.ts
  // memoryGovernanceCeiling / clampManifestationByGovernance,
  // recall-candidate-builder.ts buildRecallCandidate.
  readonly governanceCeilingByMemoryId: Readonly<Record<string, ManifestationState>>;
  // Facets the query intends; used for slice keys and demand atoms, not a scoring stream.
  readonly querySoughtFacets?: readonly string[];
}

export interface CoarseRecallCandidate {
  readonly entry: Readonly<MemoryEntry>;
  readonly answerRerankText?: string;
  readonly evidenceDocumentIdentity?: string;
  readonly evidenceSourceIdentity?: string;
  readonly evidenceSourceRole?: "user" | "assistant";
  readonly verifiedUserSupportSource?: Readonly<
    import("../query/recall-answer-support-observation.js").RecallVerifiedUserSupportSource
  >;
  readonly isAdvisory?: boolean;
  readonly originPlane?: RecallOriginPlane;
  readonly sourceChannel?: string;
  readonly sourceChannels?: readonly string[];
  readonly admissionPlanes?: readonly RecallAdmissionPlane[];
  readonly firstAdmissionPlane?: RecallAdmissionPlane;
  readonly structuralScore?: number;
  readonly scoreMultiplier?: number;
  readonly pathExpansionSources?: readonly RecallPathExpansionSourceDiagnostic[];
  // Set to "synthesis_capsule" when the candidate is sourced from an L2
  // synthesis row rather than an L1 memory_entry. The `entry` is then a
  // synthesis-shaped pseudo memory carrying the synthesis summary as content.
  readonly objectKind?: RecallCandidate["object_kind"];
}
