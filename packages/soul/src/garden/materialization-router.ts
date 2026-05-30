import {
  EvidenceHealthState,
  MemoryDimension,
  PathGovernanceClass,
  type PathGovernanceClass as PathGovernanceClassValue,
  ScopeClass,
  SourceKind,
  StorageTier,
  type CandidateMemorySignal,
  type ClaimForm,
  type EdgeProposalTriggerSourceValue,
  type ClaimKind,
  type EnforcementLevel as EnforcementLevelValue,
  type EvidenceCapsule,
  type EvidenceHealthState as EvidenceHealthStateValue,
  type EvidenceKind as EvidenceKindValue,
  type FormationKind,
  type MemoryDimension as MemoryDimensionValue,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue,
  type OriginTier,
  type PathRelation,
  type PrecedenceBasis as PrecedenceBasisValue,
  type ScopeClass as ScopeClassValue,
  type SourceKind as SourceKindValue,
  type SynthesisCapsule,
  type SynthesisType
} from "@do-soul/alaya-protocol";
import {
  type HandoffGapCreatedObject,
  type HandoffGapHandler
} from "./handoff-gap-handler.js";
import {
  readSchemaGroundedContent,
  validateSchemaGroundingForSignal
} from "./schema-grounding.js";

// invariant: RouteTarget is the routing-decision label produced by
// route(). It diversifies producer-side semantics so the live ontology
// no longer collapses every signal into the memory_and_claim 1:1:1 trio.
// MaterializationTarget.kind (the wire-level target_kind consumed by
// SignalMaterializationResult in @do-soul/alaya-core) stays inside the
// existing 5-value union for cross-package back-compat; the richer
// RouteTarget is informational and surfaces through
// MaterializationTarget.route_target.
// see also: packages/core/src/signal-service.ts SignalMaterializationTargetKind
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

interface MaterializationCreatedObject {
  readonly object_kind: string;
  readonly object_id: string;
}

type EvidenceMaterializationInput = Omit<
  EvidenceCapsule,
  "object_id" | "object_kind" | "schema_version" | "lifecycle_state" | "created_at" | "updated_at"
>;

type MemoryMaterializationInput = Omit<
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
};

type SynthesisMaterializationInput = Omit<
  SynthesisCapsule,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "synthesis_status"
>;

type ClaimMaterializationInput = Omit<
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

interface EvidenceMaterializationPort {
  create(input: EvidenceMaterializationInput): Promise<MaterializationCreatedObject>;
}

interface MemoryMaterializationPort {
  create(input: MemoryMaterializationInput): Promise<MaterializationCreatedObject>;
}

interface SynthesisMaterializationPort {
  create(input: SynthesisMaterializationInput): Promise<MaterializationCreatedObject>;
}

interface ClaimMaterializationPort {
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
// see also: packages/core/src/path-candidate-sink.ts PathCandidateSink.
// see also: packages/core/src/path-relation-proposal-service.ts seed profiles.
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
  }): Promise<boolean>;
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

// invariant: the signal-ref seed table, keyed by producer trust. These
// are agent-asserted refs on a candidate signal — the agent (or a local
// heuristic) claims the relation, so every family seeds attention_only.
// Recall eligibility is decided by recall_bias SIGN, not by
// governance_class:
//   - positive families (derives_from, recall_bias > 0) are recall-eligible
//     at birth even at attention_only — governance_class only adds the
//     +0.15 boost in scorePathRelationExpansion, it is NOT a binary recall
//     gate;
//   - negative families (supersedes / contradicts / incompatible_with,
//     recall_bias < 0) are excluded from positive expansion by their sign,
//     not by plasticity — they record suppression and only contribute once
//     a sign-aware recall pass exists;
//   - the recall-neutral exception_to marker (recall_bias == 0) is excluded
//     from positive expansion by isPathRecallEligible's strict-positive
//     gate.
// attention_only here is the trust floor: it withholds the recall_allowed
// expansion boost and the higher 0.9 strength reserved for the core seed
// profiles. recall_allowed/0.9 negatives are produced ONLY by
// ConflictDetectionService's LLM-verdict path (the system computed the
// verdict); its Jaccard rule path now also seeds attention_only because
// rule-hit conditions are agent-controllable content.
// governanceClass is further clamped to the auto-build ceiling by
// submitCandidate downstream.
// see also: packages/core/src/path-relation-proposal-service.ts seed profiles.
// see also: packages/core/src/conflict-detection-service.ts — LLM-verdict negatives.
// see also: packages/protocol/src/soul/path-relation.ts isPathRecallEligible.
// see also: signal-ref-seed-parity.test.ts — pins this live table.
const AGENT_ASSERTED_NEGATIVE_SEED_STRENGTH = 0.5;

export const SIGNAL_REF_SEED_SPECS: readonly SignalRefSeedSpec[] = [
  {
    signalRefsKey: "source_memory_refs",
    relationKind: "derives_from",
    initialStrength: 0.5,
    governanceClass: PathGovernanceClass.ATTENTION_ONLY,
    recallBiasSign: 1,
    recallBiasMagnitude: 0.5,
    evidenceBasis: ["llm_derives_inference"]
  },
  {
    signalRefsKey: "supersedes_refs",
    relationKind: "supersedes",
    initialStrength: AGENT_ASSERTED_NEGATIVE_SEED_STRENGTH,
    governanceClass: PathGovernanceClass.ATTENTION_ONLY,
    recallBiasSign: -1,
    recallBiasMagnitude: 0.5,
    evidenceBasis: ["supersession_evidence"]
  },
  {
    signalRefsKey: "exception_to_refs",
    relationKind: "exception_to",
    initialStrength: 0.9,
    // invariant: agent-asserted exception_to refs seed attention_only, not
    // recall_allowed. The ref is attacker-controllable, so it must not be
    // born recall-eligible-governance; it earns governance through
    // plasticity like the other agent-asserted families. recallBiasSign 0 /
    // magnitude 0 keep the recall-neutral marker semantics.
    governanceClass: PathGovernanceClass.ATTENTION_ONLY,
    recallBiasSign: 0,
    recallBiasMagnitude: 0,
    evidenceBasis: ["exception_evidence"]
  },
  {
    signalRefsKey: "contradicts_refs",
    relationKind: "contradicts",
    initialStrength: AGENT_ASSERTED_NEGATIVE_SEED_STRENGTH,
    governanceClass: PathGovernanceClass.ATTENTION_ONLY,
    recallBiasSign: -1,
    recallBiasMagnitude: 0.4,
    evidenceBasis: ["contradiction_evidence"]
  },
  {
    signalRefsKey: "incompatible_with_refs",
    relationKind: "incompatible_with",
    initialStrength: AGENT_ASSERTED_NEGATIVE_SEED_STRENGTH,
    governanceClass: PathGovernanceClass.ATTENTION_ONLY,
    recallBiasSign: -1,
    recallBiasMagnitude: 0.3,
    evidenceBasis: ["incompatibility_evidence"]
  }
];

export interface EdgeAutoProducerPort {
  produceForNewMemory(params: {
    readonly newMemoryId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly sourceSignalId: string;
  }): Promise<void>;
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
// see also: packages/core/src/reconciliation-service.ts
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
    },
    applyVerdict: (
      verdict: ReconciliationDecisionView
    ) => Promise<{ readonly incomingEvidenceRef?: string }>
  ): Promise<ReconciliationDecisionView>;
}

export interface MaterializationRouterDeps {
  readonly evidenceService: EvidenceMaterializationPort;
  readonly memoryService: MemoryMaterializationPort;
  readonly synthesisService: SynthesisMaterializationPort;
  readonly claimService: ClaimMaterializationPort;
  readonly pathRelationProposalPort?: PathRelationProposalPort;
  readonly pathCandidateSinkPort?: PathCandidateSinkPort;
  readonly handoffGapHandler: HandoffGapHandler;
  readonly edgeAutoProducerPort?: EdgeAutoProducerPort;
  readonly conflictDetectionPort?: ConflictDetectionPort;
  readonly reconciliationPort?: ReconciliationPort;
}

export class MaterializationRouter {
  private readonly handoffGapHandler: HandoffGapHandler;

  public constructor(private readonly dependencies: MaterializationRouterDeps) {
    this.handoffGapHandler = dependencies.handoffGapHandler;
  }

  public route(signal: CandidateMemorySignal): MaterializationTarget {
    const schemaGroundingValidation = validateSchemaGroundingForSignal(signal);
    if (schemaGroundingValidation.declared && schemaGroundingValidation.status !== "valid") {
      return {
        kind: "deferred",
        route_target: "deferred",
        routing_reason: `schema-grounded signal failed validation: ${schemaGroundingValidation.reasons.join("; ")}`
      };
    }

    if (signal.signal_kind === "potential_synthesis" && signal.evidence_refs.length >= 2) {
      return {
        kind: "synthesis",
        route_target: "synthesis",
        routing_reason: "multi-evidence synthesis candidate"
      };
    }

    if (signal.signal_kind === "potential_handoff") {
      return {
        kind: "handoff_gap",
        route_target: "handoff_gap",
        routing_reason: "run-bound handoff/gap detection"
      };
    }

    if (signal.signal_kind === "potential_evidence_anchor") {
      return {
        kind: "evidence_only",
        route_target: "evidence_only",
        routing_reason: "evidence archival"
      };
    }

    // invariant: potential_conflict routes to ConflictDetectionPort.evaluate
    // instead of the questionable-evidence fallback. Conflict signals
    // describe an alleged disagreement between memories — evaluate is
    // the producer of the contradicts / incompatible_with edges and is
    // the only sink that turns the signal into governance-actionable
    // structure. When the port is absent the signal is deferred (rather
    // than archived as questionable evidence), so the conflict surface
    // never silently degrades into noise.
    if (signal.signal_kind === "potential_conflict") {
      return {
        kind: "deferred",
        route_target: "conflict_evaluation",
        routing_reason: "potential_conflict -> ConflictDetectionPort.evaluate"
      };
    }

    if (signal.signal_kind === "potential_claim" && signal.object_kind === "path_relation") {
      return {
        kind: "deferred",
        route_target: "path_relation_proposal",
        routing_reason: "object_kind=path_relation -> path_relation_proposal"
      };
    }

    if (
      (signal.signal_kind === "potential_claim" || signal.signal_kind === "potential_preference") &&
      signal.confidence >= 0.5
    ) {
      const objectKindRoute = routeByObjectKind(signal.object_kind);
      if (objectKindRoute !== null) {
        return objectKindRoute;
      }
      // invariant: unknown object_kind never enters governance review as
      // a draft claim — that would re-introduce the producer-side claim
      // collapse the routing table was meant to break. Known claim-
      // capable dimensions are enumerated in routeByObjectKind; anything
      // outside the table is archived as questionable evidence only.
      return {
        kind: "evidence_only",
        route_target: "evidence_only",
        routing_reason: `high-confidence ${signal.signal_kind} with unrouted object_kind=${signal.object_kind} -> evidence_only`
      };
    }

    // Low-confidence unroutable signals are deferred rather than persisted as
    // questionable evidence — avoids accumulating low-confidence noise.
    if (signal.confidence < 0.3) {
      return {
        kind: "deferred",
        route_target: "deferred",
        routing_reason: "uncertain signal — deferred pending higher-confidence reconfirmation"
      };
    }

    return {
      kind: "evidence_only",
      route_target: "evidence_only",
      // invariant: unroutable signals are archived as questionable evidence only;
      // they do not produce verified long-term objects (invariant #16).
      routing_reason: "unroutable signal -> evidence archive (questionable evidence only)"
    };
  }

  public async materializeSignal(signal: CandidateMemorySignal): Promise<MaterializationResult> {
    return await this.materialize(signal, this.route(signal));
  }

  public async materialize(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    if (target.route_target === "memory_entry_only") {
      return await this.materializeMemoryEntryOnly(signal, target);
    }
    if (target.route_target === "conflict_evaluation") {
      return await this.materializeConflictEvaluation(signal, target);
    }
    if (target.route_target === "path_relation_proposal") {
      return await this.materializePathRelationProposal(signal, target);
    }
    if (target.route_target === "signal_only") {
      return this.materializeDeferred(signal, target);
    }

    switch (target.kind) {
      case "memory_and_claim":
        return await this.materializeMemoryAndClaim(signal, target);
      case "synthesis":
        return await this.materializeSynthesis(signal, target);
      case "handoff_gap":
        return await this.materializeHandoffGap(signal, target);
      case "evidence_only":
        return await this.materializeEvidenceOnly(signal, target);
      case "deferred":
        return this.materializeDeferred(signal, target);
      default: {
        const exhaustiveCheck: never = target.kind;
        return {
          signal_id: signal.signal_id,
          target_kind: exhaustiveCheck,
          route_target: target.route_target,
          routing_reason: target.routing_reason,
          created_objects: [],
          success: false,
          error: "Unsupported materialization target"
        };
      }
    }
  }

  // invariant: ingest reconciliation covers the materializeMemoryEntryOnly
  // path only (the bench `fact` object_kind). materialize_and_claim is
  // intentionally NOT reconciled in v0.3.10 — a claim-bearing signal
  // carries governance structure whose dedup is the conflict / claim
  // surface's job, not the lexical ingest gate.
  private async materializeMemoryAndClaim(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];

    try {
      const evidence = await this.dependencies.evidenceService.create(buildEvidenceInput(signal));
      createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });

      const memory = await this.dependencies.memoryService.create(buildMemoryInput(signal, [evidence.object_id]));
      createdObjects.push({ object_kind: memory.object_kind, object_id: memory.object_id });

      const claim = await this.dependencies.claimService.create(
        buildClaimInput(signal, [evidence.object_id], [memory.object_id])
      );
      createdObjects.push({ object_kind: claim.object_kind, object_id: claim.object_id });

      await this.createAllMemoryRefEdges(memory.object_id, signal);
      await this.runEdgeAutoProducer(memory.object_id, signal);
      const timeConcernProposal = await this.createTimeConcernPathRelationProposal(
        memory.object_id,
        signal
      );
      if (timeConcernProposal !== null) {
        createdObjects.push(timeConcernProposal);
      }
      // Edges created by the conflict scan complement the caller-explicit
      // hints above. see also: runConflictScan.
      await this.runConflictScan(memory.object_id, signal);

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: false,
        error: readErrorMessage(error)
      };
    }
  }

  private async materializeSynthesis(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];

    try {
      const evidenceCount = Math.max(2, signal.evidence_refs.length);
      const evidenceInputs = Array.from({ length: evidenceCount }, (_, index) =>
        buildEvidenceInput(signal, `signal_ref_${index + 1}`)
      );

      const evidences = await Promise.all(
        evidenceInputs.map(async (evidenceInput) => await this.dependencies.evidenceService.create(evidenceInput))
      );

      const evidenceIds = evidences.map((evidence) => evidence.object_id);
      for (const evidence of evidences) {
        createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });
      }

      const synthesis = await this.dependencies.synthesisService.create(
        buildSynthesisInput(signal, evidenceIds)
      );
      createdObjects.push({ object_kind: synthesis.object_kind, object_id: synthesis.object_id });

      // No graph edge here: memory_graph_edges constrains both source and target
      // to memory_entries(object_id) (migration 025). A synthesis_capsule id
      // cannot be an edge endpoint. The synthesis↔memory relation is carried by
      // synthesis.evidence_refs (which point at evidence ids) and by claim
      // resolution downstream. If a synthesis-to-memory provenance edge is
      // wanted later, it needs a schema change to widen the FK domain.

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: false,
        error: readErrorMessage(error)
      };
    }
  }

  private async materializeHandoffGap(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    try {
      const createdObject: HandoffGapCreatedObject = this.handoffGapHandler.createFromSignal(signal);

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [createdObject],
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [],
        success: false,
        error: readErrorMessage(error)
      };
    }
  }

  /** Returns a deferred result without persisting anything. */
  private materializeDeferred(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): MaterializationResult {
    return {
      signal_id: signal.signal_id,
      target_kind: "deferred",
      route_target: target.route_target,
      routing_reason: target.routing_reason,
      created_objects: [],
      success: true
    };
  }

  // invariant: produces evidence + memory but no claim. Used when the
  // signal records an outcome / reference / task_state — facts worth
  // remembering but not governance-mutating (a claim would over-promote
  // the signal into a draft awaiting review).
  // see also: materializeMemoryAndClaim — adds the claim_form layer.
  // When a reconciliationPort is wired the incoming distilled fact is
  // reconciled against the existing lexical pool: a near-exact lexical
  // duplicate is dropped (NOOP), an LLM-judged refinement updates an
  // existing row in place (UPDATE), and only a distinct fact is appended
  // (ADD). Without the port every fact is appended — the unchanged
  // default behavior.
  private async materializeMemoryEntryOnly(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    if (this.dependencies.reconciliationPort !== undefined) {
      return await this.materializeReconciledMemoryEntry(
        signal,
        target,
        this.dependencies.reconciliationPort
      );
    }
    return await this.materializeMemoryEntryAppend(signal, target);
  }

  // invariant: the unchanged default ingest path — every fact is
  // appended (evidence_capsule + memory_entry), no reconciliation. Also
  // the fallback when reconciliation throws.
  private async materializeMemoryEntryAppend(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];
    try {
      const evidence = await this.dependencies.evidenceService.create(buildEvidenceInput(signal));
      createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });

      const memory = await this.dependencies.memoryService.create(
        buildMemoryInput(signal, [evidence.object_id])
      );
      createdObjects.push({ object_kind: memory.object_kind, object_id: memory.object_id });

      await this.createAllMemoryRefEdges(memory.object_id, signal);
      await this.runEdgeAutoProducer(memory.object_id, signal);

      const timeConcernProposal = await this.createTimeConcernPathRelationProposal(
        memory.object_id,
        signal
      );
      if (timeConcernProposal !== null) {
        createdObjects.push(timeConcernProposal);
      }

      return {
        signal_id: signal.signal_id,
        // wire-level kind stays evidence_only so the cross-package
        // SignalMaterializationTargetKind union does not need to widen;
        // memory_entry_only is surfaced through route_target.
        // see also: packages/core/src/signal-service.ts SignalMaterializationTargetKind
        target_kind: "evidence_only",
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: "evidence_only",
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: false,
        error: readErrorMessage(error)
      };
    }
  }

  // invariant: decide-then-create ingest path. The core service computes
  // the verdict FIRST, then calls the applyVerdict callback inside its
  // per-workspace lock. The callback creates objects strictly per
  // verdict: ADD -> evidence_capsule + memory_entry; UPDATE ->
  // evidence_capsule only (the core service then rewrites the target row
  // and relinks the ref); NOOP -> nothing. NOOP minting no fresh capsule
  // is what keeps a re-seed of the same haystack idempotent.
  //
  // The evidence_capsule is created lazily and at most once: on a rare
  // UPDATE-apply failure the core service re-invokes applyVerdict with a
  // degraded ADD verdict, and the cached capsule ref is reused so the
  // memory_entry is appended against the already-created evidence.
  private async materializeReconciledMemoryEntry(
    signal: CandidateMemorySignal,
    target: MaterializationTarget,
    port: ReconciliationPort
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];
    let evidenceId: string | undefined;
    let appendedMemoryId: string | undefined;
    let conflictScanMemoryId: string | undefined;

    const ensureEvidence = async (): Promise<string> => {
      if (evidenceId === undefined) {
        const evidence = await this.dependencies.evidenceService.create(buildEvidenceInput(signal));
        evidenceId = evidence.object_id;
        createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });
      }
      return evidenceId;
    };

    try {
      const decision = await port.runWithDecision(
        {
          workspaceId: signal.workspace_id,
          runId: signal.run_id,
          signalId: signal.signal_id,
          incomingContent: buildDistilledFact(signal),
          incomingDomainTags: signal.domain_tags
        },
        async (verdict) => {
          if (verdict.kind === "noop") {
            // NOOP creates nothing — no evidence_capsule, no
            // memory_entry. There is no orphan to relink.
            return {};
          }
          const evidenceRef = await ensureEvidence();
          if (verdict.kind === "update") {
            // The core service rewrites the target row and relinks this
            // ref; the router creates no memory_entry on this branch.
            return { incomingEvidenceRef: evidenceRef };
          }
          // ADD: append the memory_entry against the fresh evidence.
          const memory = await this.dependencies.memoryService.create(
            buildMemoryInput(signal, [evidenceRef])
          );
          appendedMemoryId = memory.object_id;
          createdObjects.push({ object_kind: memory.object_kind, object_id: memory.object_id });
          if (verdict.runConflictScan) {
            conflictScanMemoryId = memory.object_id;
          }
          return { incomingEvidenceRef: evidenceRef };
        }
      );

      if (appendedMemoryId !== undefined) {
        await this.createAllMemoryRefEdges(appendedMemoryId, signal);
        await this.runEdgeAutoProducer(appendedMemoryId, signal);
        const timeConcernProposal = await this.createTimeConcernPathRelationProposal(
          appendedMemoryId,
          signal
        );
        if (timeConcernProposal !== null) {
          createdObjects.push(timeConcernProposal);
        }
      }

      // invariant: DELETE / supersede is the ConflictDetectionService's
      // job. Reconciliation only flags that the new fact has a same-topic
      // divergent neighbor; the contradicts / superseded_by edge + karma
      // are produced by the existing conflict scan, not a new path.
      if (conflictScanMemoryId !== undefined) {
        await this.runConflictScan(conflictScanMemoryId, signal);
      }

      const reconciledObjects =
        decision.kind !== "add" && decision.survivingObjectId !== undefined
          ? [
              ...createdObjects,
              { object_kind: "memory_entry", object_id: decision.survivingObjectId }
            ]
          : createdObjects;

      return {
        signal_id: signal.signal_id,
        target_kind: "evidence_only",
        route_target: target.route_target,
        routing_reason:
          decision.kind === "add"
            ? target.routing_reason
            : `${target.routing_reason} — reconciled: ${decision.reason}`,
        created_objects: reconciledObjects,
        success: true
      };
    } catch (error) {
      // A reconciliation backend failure must never drop the fact:
      // fall back to the unchanged blind-append path. The evidence
      // capsule may already exist from a partial applyVerdict run; the
      // append path mints its own, so a transient failure costs at most
      // one orphan capsule, never a lost fact.
      console.warn("materialization-router: reconciliation failed", {
        signalId: signal.signal_id,
        error: error instanceof Error ? error.message : String(error)
      });
      return await this.materializeMemoryEntryAppend(signal, target);
    }
  }

  // ConflictDetectionService: rule-based + optional LLM scan for memories
  // in the same workspace that contradict / are incompatible with the
  // freshly materialized one. Detection failure must not break a
  // successful memory creation.
  private async runConflictScan(
    memoryId: string,
    signal: CandidateMemorySignal
  ): Promise<void> {
    const port = this.dependencies.conflictDetectionPort;
    if (port === undefined) {
      return;
    }
    try {
      await port.detectAndLinkConflicts({
        newMemoryId: memoryId,
        newMemoryDimension: toMemoryDimension(signal.object_kind),
        newMemoryScopeClass: toScopeClass(signal.scope_hint),
        newMemoryContent: buildDistilledFact(signal),
        newMemoryDomainTags: signal.domain_tags,
        workspaceId: signal.workspace_id,
        runId: signal.run_id
      });
    } catch (err) {
      console.warn("materialization-router: conflict detection failed", {
        memoryId,
        signalId: signal.signal_id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async runEdgeAutoProducer(
    memoryId: string,
    signal: CandidateMemorySignal
  ): Promise<void> {
    const port = this.dependencies.edgeAutoProducerPort;
    if (port === undefined) {
      return;
    }
    try {
      await port.produceForNewMemory({
        newMemoryId: memoryId,
        workspaceId: signal.workspace_id,
        runId: signal.run_id,
        sourceSignalId: signal.signal_id
      });
    } catch (err) {
      console.warn("materialization-router: edge auto-producer failed", {
        memoryId,
        signalId: signal.signal_id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async materializePathRelationProposal(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const targetObjectId = readStringPayload(signal.raw_payload, "target_object_id");
    if (targetObjectId === null) {
      return {
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: `${target.routing_reason} — deferred: target_object_id missing`,
        created_objects: [],
        success: true
      };
    }

    const created = await this.createTimeConcernPathRelationProposal(targetObjectId, signal);
    return {
      signal_id: signal.signal_id,
      target_kind: "deferred",
      route_target: target.route_target,
      routing_reason: target.routing_reason,
      created_objects: created === null ? [] : [created],
      success: true
    };
  }

  private async createTimeConcernPathRelationProposal(
    targetObjectId: string,
    signal: CandidateMemorySignal
  ): Promise<MaterializationCreatedObject | null> {
    const port = this.dependencies.pathRelationProposalPort;
    if (port === undefined) {
      return null;
    }
    const timeConcern = readTimeConcernPayload(signal.raw_payload);
    if (timeConcern === null) {
      return null;
    }
    return await port.createPathRelationProposal({
      workspaceId: signal.workspace_id,
      runId: signal.run_id,
      sourceSignalId: signal.signal_id,
      targetObjectId,
      reason: `Create time_concern PathRelation for ${timeConcern.matched_text}.`,
      proposedPathRelation: buildTimeConcernPathRelationProposal(targetObjectId, timeConcern)
    });
  }

  // invariant: potential_conflict route sink. evaluate is the only
  // producer for contradicts / incompatible_with edges that originates
  // from a raw signal (memory-time detection runs through
  // detectAndLinkConflicts after the new memory is created). When the
  // port is absent or lacks evaluate, the signal is deferred so the
  // conflict surface is not silently lost as questionable evidence.
  private async materializeConflictEvaluation(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const port = this.dependencies.conflictDetectionPort;
    if (port === undefined || port.evaluate === undefined) {
      return {
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: `${target.routing_reason} — deferred: evaluate unavailable`,
        created_objects: [],
        success: true
      };
    }

    try {
      await port.evaluate({
        signalId: signal.signal_id,
        workspaceId: signal.workspace_id,
        runId: signal.run_id,
        objectKind: signal.object_kind,
        scopeHint: signal.scope_hint,
        content: buildDistilledFact(signal),
        domainTags: signal.domain_tags
      });

      return {
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [],
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [],
        success: false,
        error: readErrorMessage(error)
      };
    }
  }

  /**
   * Submits a governed path candidate for every first-class memory ref
   * carried by a memory-creating signal. Errors are swallowed per ref:
   * candidate submission must never block materialization of the memory
   * itself. This also activates the historically dormant signal-ref edge
   * source — the refs now flow through PathRelationProposalService.
   */
  private async createAllMemoryRefEdges(
    newObjectId: string,
    signal: CandidateMemorySignal
  ): Promise<void> {
    for (const spec of SIGNAL_REF_SEED_SPECS) {
      await this.submitCandidatesFromSignalRefs(newObjectId, signal, spec);
    }
  }

  // see also: createAllMemoryRefEdges — drives one spec per signal key.
  // First-class *_refs are governed path candidates, not raw_payload
  // conventions.
  private async submitCandidatesFromSignalRefs(
    newObjectId: string,
    signal: CandidateMemorySignal,
    spec: SignalRefSeedSpec
  ): Promise<void> {
    const port = this.dependencies.pathCandidateSinkPort;
    if (port === undefined) {
      return;
    }

    const refs = signal[spec.signalRefsKey];
    if (refs.length === 0) {
      return;
    }

    for (const ref of refs) {
      if (typeof ref !== "string" || ref.trim().length === 0 || ref === newObjectId) {
        continue;
      }

      try {
        await port.submitCandidate({
          workspaceId: signal.workspace_id,
          sourceAnchor: { kind: "object", object_id: newObjectId },
          targetAnchor: { kind: "object", object_id: ref },
          relationKind: spec.relationKind,
          initialStrength: spec.initialStrength,
          governanceClass: spec.governanceClass,
          evidenceBasis: spec.evidenceBasis,
          recallBiasSign: spec.recallBiasSign,
          recallBiasMagnitude: spec.recallBiasMagnitude,
          why: [
            `${spec.signalRefsKey} on candidate signal ${signal.signal_id}`,
            `run=${signal.run_id}`
          ]
        });
      } catch (err) {
        console.warn("materialization-router: path candidate submission failed", {
          sourceMemoryId: newObjectId,
          targetMemoryId: ref,
          relationKind: spec.relationKind,
          signalId: signal.signal_id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  private async materializeEvidenceOnly(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    try {
      const evidence = await this.dependencies.evidenceService.create(buildEvidenceInput(signal));

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [{ object_kind: evidence.object_kind, object_id: evidence.object_id }],
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [],
        success: false,
        error: readErrorMessage(error)
      };
    }
  }
}

// invariant: routes a high-confidence potential_claim / potential_preference
// signal by its `object_kind`. Claim-capable dimensions are enumerated
// explicitly so truly unknown kinds fall through to null and the
// caller archives them as evidence_only — keeping the producer side
// from collapsing unrecognized labels into governance-actionable
// claims. Returns null only when the object_kind is outside every
// enumerated branch.
function routeByObjectKind(objectKind: string): MaterializationTarget | null {
  switch (objectKind) {
    case "scope":
    case "task_scope":
    case "workflow_preference":
      return {
        kind: "deferred",
        route_target: "signal_only",
        routing_reason: `object_kind=${objectKind} -> signal_only (no projection beyond signal row)`
      };
    case "activity":
    case "review_scope":
      return {
        kind: "evidence_only",
        route_target: "evidence_only",
        routing_reason: `object_kind=${objectKind} -> evidence_only`
      };
    case "workspace_status":
    case "project_state":
      return {
        kind: "evidence_only",
        route_target: "evidence_short_ttl",
        routing_reason: `object_kind=${objectKind} -> evidence_short_ttl`
      };
    case "preference":
    case "decision":
    case "constraint":
    case "procedure":
    case "hazard":
    case "factual_policy":
    case "exception":
    case "glossary":
    case "episode":
      return {
        kind: "memory_and_claim",
        route_target: "memory_and_claim_draft",
        routing_reason: `object_kind=${objectKind} -> memory_and_claim_draft (claim_status defaulted to draft by ClaimService)`
      };
    case "outcome":
    case "reference":
    case "task_state":
    case "fact":
      return {
        kind: "evidence_only",
        route_target: "memory_entry_only",
        routing_reason: `object_kind=${objectKind} -> memory_entry_only (evidence + memory, no claim)`
      };
    default:
      return null;
  }
}

interface TimeConcernPayload {
  readonly window_digest: string;
  readonly matched_text: string;
}

function readTimeConcernPayload(rawPayload: CandidateMemorySignal["raw_payload"]): TimeConcernPayload | null {
  const timeConcern = rawPayload.time_concern;
  if (timeConcern === null || typeof timeConcern !== "object" || Array.isArray(timeConcern)) {
    return null;
  }
  const candidate = timeConcern as Record<string, unknown>;
  const windowDigest = normalizePayloadString(candidate.window_digest);
  const matchedText = normalizePayloadString(candidate.matched_text);
  if (windowDigest === null || matchedText === null) {
    return null;
  }
  return { window_digest: windowDigest, matched_text: matchedText };
}

function readStringPayload(
  rawPayload: CandidateMemorySignal["raw_payload"],
  key: string
): string | null {
  return normalizePayloadString(rawPayload[key]);
}

function normalizePayloadString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function buildTimeConcernPathRelationProposal(
  targetObjectId: string,
  timeConcern: TimeConcernPayload
): PathRelationProposalPayload {
  return {
    target_anchor: {
      kind: "time_concern",
      source_object_id: targetObjectId,
      window_digest: timeConcern.window_digest
    },
    constitution: {
      relation_kind: "time_concern",
      why_this_relation_exists: [`matched temporal expression: ${timeConcern.matched_text}`]
    },
    effect_vector: {
      salience: 0.6,
      recall_bias: 0.7,
      verification_bias: 0.1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.4,
      direction_bias: "source_to_target",
      stability_class: "normal",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "janitor_ttl_low_strength"
    },
    legitimacy: {
      evidence_basis: ["garden:time_concern"],
      governance_class: PathGovernanceClass.RECALL_ALLOWED
    }
  };
}

function computeEvidenceHealthState(signal: CandidateMemorySignal): EvidenceHealthStateValue {
  // Invariant #16: objects without evidence_refs must default to questionable,
  // not verified. Signals from local heuristics carry no supporting evidence.
  if (signal.evidence_refs.length === 0) {
    return EvidenceHealthState.QUESTIONABLE;
  }
  return EvidenceHealthState.VERIFIED;
}

// invariant: evidence_kind diversifies producer-side so the live ontology
// no longer collapses to 100% `inferred`. Mapping rules:
//   - user_seed / import sources → user_statement (operator-attested origin)
//   - signals carrying evidence_refs → external_reference (linked anchor)
//   - everything else (LLM / Garden compile) → inferred (default)
function pickEvidenceKind(signal: CandidateMemorySignal): EvidenceKindValue {
  if (signal.source === "user_seed" || signal.source === "import") {
    return "user_statement";
  }
  if (signal.evidence_refs.length > 0) {
    return "external_reference";
  }
  return "inferred";
}

function buildEvidenceInput(
  signal: CandidateMemorySignal,
  summarySuffix?: string
): EvidenceMaterializationInput {
  const excerpt = buildSignalSummary(signal);

  return {
    created_by: signal.source,
    evidence_kind: pickEvidenceKind(signal),
    semantic_anchor: {
      topic: buildTopicKey(signal),
      keywords: [...signal.domain_tags],
      summary: appendSummarySuffix(excerpt, summarySuffix)
    },
    event_anchor: {
      event_type: "soul.signal.emitted",
      event_id: null,
      occurred_at: signal.created_at
    },
    physical_anchor: buildSignalPhysicalAnchor(signal),
    evidence_health_state: computeEvidenceHealthState(signal),
    gist: appendSummarySuffix(excerpt, summarySuffix),
    excerpt,
    source_hash: null,
    run_id: signal.run_id,
    workspace_id: signal.workspace_id,
    surface_id: signal.surface_id
  };
}

function buildSignalPhysicalAnchor(signal: CandidateMemorySignal): EvidenceCapsule["physical_anchor"] {
  const artifactRef = signal.evidence_refs.find((ref) => ref.trim().length > 0)?.trim() ?? null;
  if (artifactRef === null) {
    return null;
  }

  return {
    file_path: null,
    line_range: null,
    symbol_name: null,
    artifact_ref: artifactRef
  };
}

function buildMemoryInput(
  signal: CandidateMemorySignal,
  evidenceRefs: readonly string[]
): MemoryMaterializationInput {
  return {
    created_by: signal.source,
    dimension: toMemoryDimension(signal.object_kind),
    source_kind: toSourceKind(signal.source),
    formation_kind: toFormationKind(signal),
    scope_class: toScopeClass(signal.scope_hint),
    // invariant: MemoryEntry.content is the distilled fact, never raw turn.
    // Raw evidence lives in EvidenceCapsule.gist / .excerpt and is reached
    // via evidence_refs + soul.open_pointer. see buildDistilledFact for
    // caller-provided distilled_fact vs rule-based fallback.
    content: buildDistilledFact(signal),
    domain_tags: signal.domain_tags,
    evidence_refs: evidenceRefs,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    surface_id: signal.surface_id,
    storage_tier: StorageTier.HOT
  };
}

function buildClaimInput(
  signal: CandidateMemorySignal,
  evidenceRefs: readonly string[],
  sourceObjectRefs: readonly string[]
): ClaimMaterializationInput {
  const claimKind = toClaimKind(signal.object_kind);
  const enforcementLevel: EnforcementLevelValue =
    claimKind === "constraint" || claimKind === "factual_policy" ? "strict" : "preferred";

  return {
    created_by: signal.source,
    governance_subject_domain: `signal.${signal.object_kind}`,
    governance_subject_qualifiers: {
      workspace: signal.workspace_id,
      run: signal.run_id
    },
    claim_kind: claimKind,
    scope_class: toScopeClass(signal.scope_hint),
    enforcement_level: enforcementLevel,
    origin_tier: toOriginTier(signal.source),
    precedence_basis: pickPrecedenceBasis(signal, enforcementLevel),
    proposition_digest: buildDistilledFact(signal),
    evidence_refs: evidenceRefs,
    source_object_refs: sourceObjectRefs,
    workspace_id: signal.workspace_id
  };
}

// invariant: producer-side rule mirrors the canonical helper
// `derivePrecedenceBasis` in packages/core/src/claim-service.ts. Priority
// (highest wins): user_override > authority > recency > evidence_strength.
// Garden cannot import from packages/core (invariant §6), so the rule is
// duplicated here with the cross-file anchor below; both producers stay
// in lockstep through identical truth-table tests.
// see also: packages/core/src/claim-service.ts derivePrecedenceBasis
function pickPrecedenceBasis(
  signal: CandidateMemorySignal,
  enforcementLevel: EnforcementLevelValue
): PrecedenceBasisValue {
  if (signal.source === "user_seed" || hasUserOverrideMarker(signal)) {
    return "user_override";
  }
  if (enforcementLevel === "strict") {
    return "authority";
  }
  if (hasSupersedeIntent(signal)) {
    return "recency";
  }
  return "evidence_strength";
}

function hasUserOverrideMarker(signal: CandidateMemorySignal): boolean {
  return signal.raw_payload.user_override === true;
}

function hasSupersedeIntent(signal: CandidateMemorySignal): boolean {
  return signal.supersedes_refs.some((ref) => ref.trim().length > 0);
}

function buildSynthesisInput(
  signal: CandidateMemorySignal,
  evidenceRefs: readonly string[]
): SynthesisMaterializationInput {
  return {
    created_by: signal.source,
    topic_key: buildTopicKey(signal),
    synthesis_type: toSynthesisType(),
    summary: buildDistilledFact(signal),
    evidence_refs: evidenceRefs,
    source_memory_refs: [],
    workspace_id: signal.workspace_id,
    run_id: signal.run_id
  };
}

function toScopeClass(scopeHint: string | null): ScopeClassValue {
  switch (scopeHint) {
    case ScopeClass.GLOBAL_CORE:
      return ScopeClass.GLOBAL_CORE;
    case ScopeClass.GLOBAL_DOMAIN:
      return ScopeClass.GLOBAL_DOMAIN;
    case ScopeClass.PROJECT:
    default:
      return ScopeClass.PROJECT;
  }
}

function toMemoryDimension(objectKind: string): MemoryDimensionValue {
  switch (objectKind) {
    case MemoryDimension.PREFERENCE:
      return MemoryDimension.PREFERENCE;
    case MemoryDimension.CONSTRAINT:
      return MemoryDimension.CONSTRAINT;
    case MemoryDimension.DECISION:
      return MemoryDimension.DECISION;
    case MemoryDimension.PROCEDURE:
      return MemoryDimension.PROCEDURE;
    case MemoryDimension.HAZARD:
      return MemoryDimension.HAZARD;
    case MemoryDimension.GLOSSARY:
      return MemoryDimension.GLOSSARY;
    case MemoryDimension.EPISODE:
      return MemoryDimension.EPISODE;
    default:
      return MemoryDimension.FACT;
  }
}

function toSourceKind(source: CandidateMemorySignal["source"]): SourceKindValue {
  switch (source) {
    case "user_seed":
      return SourceKind.SEED;
    case "import":
      return SourceKind.IMPORT;
    case "model_tool":
    case "garden_compile":
    default:
      return SourceKind.COMPILER;
  }
}

function toFormationKind(signal: CandidateMemorySignal): FormationKind {
  switch (signal.source) {
    case "user_seed":
      return "explicit";
    case "import":
      return "imported";
    case "model_tool":
      // model_tool signals carrying source_memory_refs build on top of
      // existing memories (a derivation); plain LLM emissions without
      // such refs are inferences.
      return signal.source_memory_refs.length > 0 ? "derived" : "inferred";
    case "garden_compile":
    default:
      return "extracted";
  }
}

function toClaimKind(objectKind: string): ClaimKind {
  switch (objectKind) {
    case "preference":
      return "preference";
    case "decision":
      return "decision";
    case "procedure":
      return "procedure";
    case "hazard":
      return "hazard";
    case "factual_policy":
      return "factual_policy";
    case "exception":
      return "exception";
    case "glossary":
      return "glossary";
    case "episode":
      return "episode";
    case "constraint":
    default:
      return "constraint";
  }
}

function toOriginTier(source: CandidateMemorySignal["source"]): OriginTier {
  switch (source) {
    case "user_seed":
      return "seed";
    case "import":
      return "imported";
    case "model_tool":
    case "garden_compile":
    default:
      return "compiler_extracted";
  }
}

function toSynthesisType(): SynthesisType {
  return "cross_evidence";
}

function buildTopicKey(signal: CandidateMemorySignal): string {
  const primaryTag = signal.domain_tags[0] ?? "signal";
  const basis = `${primaryTag}_${signal.object_kind}`.toLowerCase();
  const topicKey = basis.replace(/[^a-z0-9_.-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

  return topicKey.length === 0 ? `signal_${signal.signal_id}` : topicKey;
}

function buildSignalSummary(signal: CandidateMemorySignal): string {
  const schemaGroundedContent = readSchemaGroundedContent(signal);
  if (schemaGroundedContent !== null) {
    return schemaGroundedContent;
  }

  const excerpt = signal.raw_payload.excerpt;
  if (typeof excerpt === "string" && excerpt.trim().length > 0) {
    return excerpt.trim();
  }

  const matchedText = signal.raw_payload.matched_text;
  if (typeof matchedText === "string" && matchedText.trim().length > 0) {
    return matchedText.trim();
  }

  return `Signal ${signal.signal_id} (${signal.signal_kind})`;
}

// invariant: MemoryEntry.content / Claim.proposition_digest /
// Synthesis.summary store a distilled fact, not raw turn. Raw turn lives
// in EvidenceCapsule.gist / .excerpt. Caller (LLM / user / bench harness)
// may supply raw_payload.distilled_fact directly; otherwise a rule-based
// fallback takes the first two sentences capped at DISTILLED_FACT_MAX_CHARS.
// Single source of truth for the distilled-fact length budget: the
// official-API garden provider clamps raw_payload.distilled_fact to this
// same constant. see also: garden/compute-provider.ts.
// invariant: kept <= AUDIT_DROPPED_CONTENT_MAX_CHARS (500) in
// packages/core/src/reconciliation-service.ts so a dropped fact stays
// fully reconstructable from the reconciliation audit row.
export const DISTILLED_FACT_MAX_CHARS = 500;
const DISTILLED_FACT_MAX_SENTENCES = 2;

export function buildDistilledFact(signal: CandidateMemorySignal): string {
  const providedDistilled = signal.raw_payload.distilled_fact;
  if (typeof providedDistilled === "string") {
    const trimmed = providedDistilled.trim();
    if (trimmed.length > 0) {
      // A caller-supplied distilled_fact is already a resolved
      // one-assertion fact; use it verbatim when within cap. The "..."
      // truncation belongs only to ruleDistillFromRaw (raw -> distilled).
      // An over-cap supplied fact is not the normal path once the
      // provider clamps to DISTILLED_FACT_MAX_CHARS — clamp defensively.
      return trimmed.length <= DISTILLED_FACT_MAX_CHARS
        ? trimmed
        : trimmed.slice(0, DISTILLED_FACT_MAX_CHARS);
    }
  }
  return ruleDistillFromRaw(buildSignalSummary(signal));
}

// see also: buildDistilledFact — fallback path when caller does not supply
// raw_payload.distilled_fact. Sentence boundary scan covers Latin (.!?;)
// and CJK (。！？；) terminators; falls back to char-count slice when no
// terminator is found in the first 2x window.
function ruleDistillFromRaw(raw: string): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "";
  }
  const sentenceRegex = /[^.!?;。！？；]+[.!?;。！？；]+/gu;
  const sentences = normalized.match(sentenceRegex) ?? [];
  // invariant: always take at most DISTILLED_FACT_MAX_SENTENCES sentences
  // even when the raw fits inside the char cap. Distilled fact is the
  // *first claim* of a turn, not the entire turn.
  if (sentences.length >= DISTILLED_FACT_MAX_SENTENCES) {
    const head = sentences.slice(0, DISTILLED_FACT_MAX_SENTENCES).join("").trim();
    if (head.length > 0 && head.length <= DISTILLED_FACT_MAX_CHARS) {
      return head;
    }
    return `${head.slice(0, DISTILLED_FACT_MAX_CHARS - 3)}...`;
  }
  if (normalized.length <= DISTILLED_FACT_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, DISTILLED_FACT_MAX_CHARS - 3)}...`;
}

function appendSummarySuffix(summary: string, suffix?: string): string {
  if (suffix === undefined) {
    return summary;
  }

  return `${summary} ${suffix}`;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown materialization error";
}
