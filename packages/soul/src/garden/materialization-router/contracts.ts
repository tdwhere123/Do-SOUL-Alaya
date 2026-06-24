import {
  type ClaimForm,
  type EdgeProposalTriggerSourceValue,
  type EvidenceCapsule,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue,
  type PathGovernanceClass as PathGovernanceClassValue,
  type PathRelation,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { type HandoffGapHandler } from "../handoff-gap-handler.js";

// invariant: RouteTarget is the routing-decision label produced by
// route(). It diversifies producer-side semantics so the live ontology
// no longer collapses every signal into the memory_and_claim 1:1:1 trio.
// MaterializationTarget.kind (the wire-level target_kind consumed by
// SignalMaterializationResult in @do-soul/alaya-core) stays inside the
// existing 5-value union for cross-package back-compat; the richer
// RouteTarget is informational and surfaces through
// MaterializationTarget.route_target.
// see also: packages/core/src/memory/signal-service.ts SignalMaterializationTargetKind
export type RouteTarget =
  | "signal_only"
  | "evidence_only"
  | "evidence_short_ttl"
  | "memory_entry_only"
  | "memory_and_claim_draft"
  | "conflict_evaluation"
  | "path_relation_proposal"
  | "synthesis"
  | "handoff_gap"
  | "deferred";

export interface MaterializationTarget {
  readonly kind: "memory_and_claim" | "synthesis" | "handoff_gap" | "evidence_only" | "deferred";
  readonly route_target: RouteTarget;
  readonly routing_reason: string;
}

export interface MaterializationResult {
  readonly signal_id: string;
  readonly target_kind: MaterializationTarget["kind"];
  readonly route_target: RouteTarget;
  readonly routing_reason: string;
  readonly created_objects: readonly { object_kind: string; object_id: string }[];
  readonly success: boolean;
  readonly error?: string;
}

export interface MaterializationCreatedObject {
  readonly object_kind: string;
  readonly object_id: string;
}

export type EvidenceMaterializationInput = Omit<
  EvidenceCapsule,
  "object_id" | "object_kind" | "schema_version" | "lifecycle_state" | "created_at" | "updated_at"
>;

export type MemoryMaterializationInput = Omit<
  MemoryEntry,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "storage_tier"
  | "activation_score"
  | "retention_score"
  | "manifestation_state"
  | "retention_state"
  | "decay_profile"
  | "confidence"
  | "last_used_at"
  | "last_hit_at"
  | "reinforcement_count"
  | "contradiction_count"
  | "superseded_by"
> & {
  readonly storage_tier?: MemoryEntry["storage_tier"];
  // invariant: atomic create + enrich_pending no-drop marker. When set, the
  // memory-create port commits the row + the enrich_pending marker in ONE
  // transaction (or neither, so the originating signal can replay). The router
  // sets this ONLY on memory-creating branches that owe enrichment; the port
  // reports back via MaterializationCreatedObject.enrichmentEnqueued. When the
  // port does not honor the atomic seam the router falls back to a loud (not
  // swallowed) separate enqueue. workspace_id + memory_id are filled by the
  // truth boundary from the created row.
  // see also: packages/core/src/memory/memory-service/service.ts:MemoryService.create.
  readonly enqueueEnrichment?: {
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  };
};

export type SynthesisMaterializationInput = Omit<
  SynthesisCapsule,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "synthesis_status"
>;

export type ClaimMaterializationInput = Omit<
  ClaimForm,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "governance_subject"
  | "claim_status"
> & {
  readonly governance_subject_domain: string;
  readonly governance_subject_qualifiers?: Record<string, string>;
};

export interface EvidenceMaterializationPort {
  create(input: EvidenceMaterializationInput): Promise<MaterializationCreatedObject>;
  deleteCreatedEvidence(objectId: string): Promise<void>;
}

// invariant: the memory-create port reports whether the enrich_pending no-drop
// marker was enqueued atomically with the row (see MemoryMaterializationInput
// .enqueueEnrichment). enrichmentEnqueued === true means the row + marker
// committed together; otherwise the router must enqueue the marker itself (loud
// on failure — it is the mandatory no-drop handoff, never warn-and-continue).
// see also: packages/core/src/memory/memory-service/service.ts:MemoryService.create.
export type MemoryMaterializationCreatedObject = MaterializationCreatedObject & {
  readonly enrichmentEnqueued?: boolean;
};

export interface MemoryMaterializationPort {
  create(input: MemoryMaterializationInput): Promise<MemoryMaterializationCreatedObject>;
}

export interface SynthesisMaterializationPort {
  create(input: SynthesisMaterializationInput): Promise<MaterializationCreatedObject>;
}

export interface ClaimMaterializationPort {
  create(input: ClaimMaterializationInput): Promise<MaterializationCreatedObject>;
}

export interface PathRelationProposalPayload {
  readonly target_anchor: PathRelation["anchors"]["target_anchor"];
  readonly constitution: PathRelation["constitution"];
  readonly effect_vector: PathRelation["effect_vector"];
  readonly plasticity_state: PathRelation["plasticity_state"];
  readonly lifecycle: PathRelation["lifecycle"];
  readonly legitimacy: PathRelation["legitimacy"];
}

export interface PathRelationProposalPort {
  assertPathRelationProposalAvailable?(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly sourceSignalId: string;
  }): Promise<void>;
  createPathRelationProposal(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly sourceSignalId: string;
    readonly targetObjectId: string;
    readonly reason: string;
    readonly proposedPathRelation: PathRelationProposalPayload;
  }): Promise<MaterializationCreatedObject>;
}

export interface GraphEdgeCreationPort {
  createEdge(params: {
    readonly sourceMemoryId: string;
    readonly targetMemoryId: string;
    readonly edgeType: MemoryGraphEdgeTypeValue;
    readonly workspaceId: string;
    readonly runId?: string | null;
    readonly triggerSource?: EdgeProposalTriggerSourceValue;
    readonly confidence?: number;
    readonly reason?: string | null;
    readonly sourceSignalId?: string | null;
  }): Promise<void>;
}

// invariant: signal-ref sink. The router no longer writes
// memory_graph_edges for a signal's first-class *_refs; it submits a
// governed path candidate through PathRelationProposalService.submitCandidate
// (the daemon wires this port to it). source_memory_refs seed a positive
// derives_from path; supersedes/contradicts/incompatible_with seed weak
// negative lifecycle paths (recallBiasSign -1, attention_only) that must
// earn recall eligibility through plasticity reinforcement — an
// agent-asserted ref never mints a recall_allowed negative path;
// exception_to seeds a neutral marker (recallBiasSign 0). @do-soul/alaya-soul
// cannot import @do-soul/alaya-core (invariants §6), so the seed shape
// crosses the port boundary structurally. governanceClass is clamped to the
// auto-build ceiling by submitCandidate downstream.
// see also: packages/core/src/path-graph/path-candidate-sink.ts PathCandidateSink.
// see also: packages/core/src/path-graph/path-relation-proposal-service.ts seed profiles.

// invariant: structural mirror of core's PathMintOutcome (@do-soul/alaya-soul
// cannot import @do-soul/alaya-core, invariants §6, so the four-state crosses
// the port boundary as a literal union, like the seed shape above). The router
// MUST preserve the rejected/failed distinction the sink decides: "rejected" is
// a PERMANENT B3 anchor refusal (clean silent drop, already audited downstream),
// "failed" is a TRANSIENT mint error. The synchronous write path first tries to
// persist a durable path_relation proposal for failed refs; when that post-create
// write is unavailable, the already-durable enrich_pending marker makes the
// failure retryable in the BULK_ENRICH worker instead of terminally failing a
// partially materialized signal.
// see also: packages/core/src/path-graph/path-relation-proposal-service.ts PathMintOutcome.
export type PathCandidateMintOutcome = "applied" | "already_present" | "rejected" | "failed";
export type SignalRefTransientFailureMode = "durable_proposal" | "throw_for_retry";

export interface PathCandidateSinkPort {
  submitCandidate(input: {
    readonly workspaceId: string;
    readonly sourceAnchor: { readonly kind: "object"; readonly object_id: string };
    readonly targetAnchor: { readonly kind: "object"; readonly object_id: string };
    readonly relationKind: string;
    readonly initialStrength: number;
    readonly governanceClass: PathGovernanceClassValue;
    readonly evidenceBasis: readonly string[];
    readonly recallBiasSign: 1 | 0 | -1;
    readonly recallBiasMagnitude?: number;
    readonly why?: readonly string[];
    readonly runId?: string | null;
  }): Promise<PathCandidateMintOutcome>;
}

export interface SignalRefSeedSpec {
  readonly signalRefsKey:
    | "source_memory_refs"
    | "supersedes_refs"
    | "exception_to_refs"
    | "contradicts_refs"
    | "incompatible_with_refs";
  readonly relationKind: string;
  readonly initialStrength: number;
  readonly governanceClass: PathGovernanceClassValue;
  readonly recallBiasSign: 1 | 0 | -1;
  readonly recallBiasMagnitude: number;
  readonly evidenceBasis: readonly string[];
}

// invariant: write-path/enrich-path decouple (S3c). Conflict detection +
// edge auto-production are O(enrichment) and must NOT run inline on the
// synchronous write-path. The router enqueues one durable enrich_pending
// marker per freshly materialized memory and acks; the Garden BULK_ENRICH
// Librarian task drains the markers and runs the governed enrichment
// services off-path. enqueue is an idempotent upsert downstream, so a
// re-materialize of the same memory never duplicates enrichment.
// see also: packages/storage/src/repos/enrich-pending-repo.ts
// see also: apps/core-daemon/src/garden-runtime.ts — BULK_ENRICH drain worker.
export interface EnrichPendingPort {
  enqueue(params: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }): void;
}

// invariant: detectAndLinkConflicts runs at memory materialization time
// against the new memory's id; evaluate runs against a raw
// potential_conflict signal that has no memory yet. The router routes
// the potential_conflict signal_kind to evaluate; the established
// memory_and_claim_draft path keeps using detectAndLinkConflicts as a
// post-create scan.
export interface ConflictDetectionPort {
  detectAndLinkConflicts(params: {
    readonly newMemoryId: string;
    readonly newMemoryDimension: string;
    readonly newMemoryScopeClass: string;
    readonly newMemoryContent: string;
    readonly newMemoryDomainTags: readonly string[];
    readonly workspaceId: string;
    readonly runId: string;
  }): Promise<void>;
  evaluate?(params: {
    readonly signalId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly objectKind: string;
    readonly scopeHint: string | null;
    readonly content: string;
    readonly domainTags: readonly string[];
  }): Promise<void>;
}

// invariant: ingest-time reconciliation. The router asks this port what
// to do with an incoming distilled fact before appending it: ADD (create
// as today), UPDATE (an in-place refine applied to an existing row), or
// NOOP (a near-exact lexical duplicate). The decision is computed in
// @do-soul/alaya-core (the truth boundary) over the lexical FTS pool
// plus, for the ambiguous band, an ingest-time LLM judge — Garden cannot
// import core (invariants §6), so the decision arrives through this
// port. When the port is absent the ingest path appends every fact
// unchanged, so default production behavior is unchanged unless the
// daemon wires it.
//
// decide-then-create: the decision is computed BEFORE any object is
// created. The core service calls the router-supplied `applyVerdict`
// callback once the verdict is known, inside its per-workspace lock:
//   - add    -> the router creates the evidence_capsule + memory_entry
//   - update -> the router creates the evidence_capsule; the core service
//               then rewrites the target row and relinks that fresh
//               evidence ref so durable content keeps matching evidence
//   - noop   -> the router creates nothing; the drop is audited
// NOOP creating no object is what makes a re-seed of the same haystack
// idempotent — no fresh capsule is minted to accumulate on the surviving
// row. `survivingObjectId` is the row that ends up holding the fact for
// UPDATE / NOOP — the bench scoring sidecar remaps object_id -> answer
// turn through it.
// see also: packages/core/src/governance/reconciliation-service.ts
export interface ReconciliationDecisionView {
  readonly kind: "add" | "update" | "noop";
  /** The row that ends up holding the fact for UPDATE / NOOP. */
  readonly survivingObjectId?: string;
  readonly runConflictScan: boolean;
  readonly reason: string;
}

export interface ReconciliationPort {
  runWithDecision(
    input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly signalId: string;
      readonly incomingContent: string;
      readonly incomingDomainTags: readonly string[];
      readonly incomingProjectionFields?: ReconciliationProjectionFields;
    },
    applyVerdict: (
      verdict: ReconciliationDecisionView
    ) => Promise<{ readonly incomingEvidenceRef?: string }>
  ): Promise<ReconciliationDecisionView>;
}

export type ReconciliationProjectionFields = Pick<
  MemoryMaterializationInput,
  | "projection_schema_version"
  | "event_time_start"
  | "event_time_end"
  | "valid_from"
  | "valid_to"
  | "time_precision"
  | "time_source"
  | "preference_subject"
  | "preference_predicate"
  | "preference_object"
  | "preference_category"
  | "preference_polarity"
>;

export interface MaterializationRouterDeps {
  readonly evidenceService: EvidenceMaterializationPort;
  readonly memoryService: MemoryMaterializationPort;
  readonly synthesisService: SynthesisMaterializationPort;
  readonly claimService: ClaimMaterializationPort;
  readonly pathRelationProposalPort?: PathRelationProposalPort;
  readonly pathCandidateSinkPort?: PathCandidateSinkPort;
  readonly handoffGapHandler: HandoffGapHandler;
  // invariant: post-materialization enrichment (edge auto-production +
  // conflict detection's detectAndLinkConflicts) no longer runs inline.
  // When enrichPendingPort is wired the write-path enqueues a durable marker
  // per new memory; the Garden BULK_ENRICH worker runs the governed
  // enrichment services off-path. When it is absent no enrichment is
  // enqueued — the same "enrichment disabled" behavior as an absent service.
  readonly enrichPendingPort?: EnrichPendingPort;
  // conflictDetectionPort is retained for the potential_conflict `evaluate`
  // route (a raw signal with no memory yet); detectAndLinkConflicts has moved
  // to the BULK_ENRICH worker. see also: materializeConflictEvaluation.
  readonly conflictDetectionPort?: ConflictDetectionPort;
  readonly reconciliationPort?: ReconciliationPort;
  // When true, a high-confidence potential_claim/potential_preference whose
  // free-form object_kind is outside routeByObjectKind is kept as a recallable
  // memory_entry (memory_entry_only — no draft claim) instead of dropped to
  // evidence_only. Aligns production ingest with the open-vocabulary extractor
  // (which emits ~10^5 distinct kinds, ~99.9% outside the 13-kind table). The
  // bench seeds every haystack turn, so production must retain these facts for
  // the bench to test production. Default-off preserves curated behavior.
  readonly retainUnroutedHighConfidenceFacts?: boolean;
  // Minimum confidence for a potential_claim/potential_preference to materialize
  // (default 0.5). Lowering it recovers facts the open-vocabulary extractor
  // emitted with moderate confidence (the 0.3-0.5 band, ~10% of signals) that
  // would otherwise be archived to evidence_only. Trades curation for recall;
  // shared by prod + bench via the single daemon construction.
  readonly materializationConfidenceFloor?: number;
  // Widen each evidence capsule's searchable excerpt/gist to the signal's full
  // source turn (full_turn_content) instead of the matched_text span, so evidence
  // FTS can recall a memory whose distilled content dropped the query terms.
  readonly fullTurnEvidenceExcerpt?: boolean;
  // When true, a signal whose object_kind routes to signal_only but whose
  // raw_payload carries a memory projection (preference_profile /
  // temporal_projection) is lifted to memory_entry_only so the projection lands
  // on a recallable memory_entry instead of dying on the signal row. Default-off
  // keeps the curated signal_only deferral byte-identical.
  readonly projectionRoutingEnabled?: boolean;
}
