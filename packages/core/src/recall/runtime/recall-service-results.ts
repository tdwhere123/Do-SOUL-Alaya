import type {
  ManifestationState,
  MemoryEntry,
  PathAnchorRef,
  RecallCandidate,
  RecallOriginPlane,
  SoulActiveConstraint,
  SoulMemorySearchDegradationReason
} from "@do-soul/alaya-protocol";

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

export interface EvidenceSupportVector {
  readonly source_kind: "evidence_ref";
  readonly source_id: string;
  readonly support: number;
}

export interface RecallResult {
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly active_constraints: readonly Readonly<SoulActiveConstraint>[];
  readonly active_constraints_count: number;
  readonly total_scanned: number;
  readonly coarse_filter_count: number;
  readonly fine_assessment_count: number;
  readonly degradation_reason: SoulMemorySearchDegradationReason | null;
  readonly working_projection: null;
  readonly diagnostics?: Readonly<RecallDiagnostics>;
}

export interface RecallSupplementaryData {
  readonly queryProbes: Readonly<import("../query/recall-query-probes.js").RecallQueryProbes>;
  readonly ftsRanks: Readonly<Record<string, number>>;
  // Trigram-lane normalized rank, surfaced separately from ftsRanks so the
  // trigram_fts fusion stream can read substring / spelling-variant / CJK
  // matches without conflating them with word-level porter/exact ranks.
  readonly trigramFtsRanks: Readonly<Record<string, number>>;
  readonly synthesisFtsRanks: Readonly<Record<string, number>>;
  readonly evidenceFtsRanks: Readonly<Record<string, number>>;
  // Per-ref grain (evidenceFtsRanks aggregates to memory id); absent → lane-count fallback.
  readonly evidenceFtsRanksPerRef?: Readonly<Record<string, number>>;
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
  // Active sign-aware suppression deltas keyed by target memory id. A positive
  // value is subtracted from that memory's fused recall score before final
  // ranking, demoting targets that a reinforced negative path (recall_bias < 0)
  // suppresses. Empty when no negative path anchored on an expansion seed.
  // see also: recall-service.ts collectNegativePathSuppressions /
  // applyPathSuppressionToFusionScores.
  readonly pathSuppressionScores: Readonly<Record<string, number>>;
  readonly embeddingSimilarityScores: Readonly<Record<string, number>>;
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
  // Facets the query intends; the facet_overlap fusion stream scores candidates by how many they carry.
  readonly querySoughtFacets?: readonly string[];
}

export interface CoarseRecallCandidate {
  readonly entry: Readonly<MemoryEntry>;
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
