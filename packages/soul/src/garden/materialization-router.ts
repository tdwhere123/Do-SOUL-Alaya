import {
  EvidenceHealthState,
  MemoryDimension,
  MemoryGraphEdgeType,
  ScopeClass,
  SourceKind,
  StorageTier,
  type CandidateMemorySignal,
  type ClaimForm,
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
  | "authority_round_count"
  | "cooldown_until"
  | "promotion_state"
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

export interface GraphEdgeCreationPort {
  createEdge(params: {
    readonly sourceMemoryId: string;
    readonly targetMemoryId: string;
    readonly edgeType: MemoryGraphEdgeTypeValue;
    readonly workspaceId: string;
    readonly runId?: string | null;
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

export interface MaterializationRouterDeps {
  readonly evidenceService: EvidenceMaterializationPort;
  readonly memoryService: MemoryMaterializationPort;
  readonly synthesisService: SynthesisMaterializationPort;
  readonly claimService: ClaimMaterializationPort;
  readonly handoffGapHandler: HandoffGapHandler;
  readonly graphEdgePort?: GraphEdgeCreationPort;
  readonly conflictDetectionPort?: ConflictDetectionPort;
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

    if (
      (signal.signal_kind === "potential_claim" || signal.signal_kind === "potential_preference") &&
      signal.confidence >= 0.5
    ) {
      const objectKindRoute = routeByObjectKind(signal.object_kind);
      if (objectKindRoute !== null) {
        return objectKindRoute;
      }
      return {
        kind: "memory_and_claim",
        route_target: "memory_and_claim_draft",
        routing_reason:
          signal.evidence_refs.length >= 1
            ? "reusable signal with evidence support"
            : "high-confidence preference/claim — evidence created during materialization"
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

      // Create derives_from edges to any memory IDs the model tagged in raw_payload.source_memory_refs.
      // memory_graph_edges is memory↔memory (migration 025 FK both ends → memory_entries),
      // so evidence ids cannot be edge endpoints here — invariants §8 (memory↔evidence) is
      // captured by memory.evidence_refs / claim.source_object_refs, not by a graph edge.
      await this.createSourceMemoryEdges(
        memory.object_id,
        signal,
        MemoryGraphEdgeType.DERIVES_FROM
      );
      // invariant: caller-explicit ontology hints land here. Each
      // raw_payload.*_refs key maps 1:1 to a MemoryGraphEdgeType:
      //   supersedes_refs        → SUPERSEDES (new replaces old)
      //   exception_to_refs      → EXCEPTION_TO (new is exception of old)
      //   contradicts_refs       → CONTRADICTS (new contradicts old)
      //   incompatible_with_refs → INCOMPATIBLE_WITH (cross-dimension)
      // see also: createEdgesFromRawPayloadRefs
      // see also: ConflictDetectionService — rule-based + LLM producer
      //   for contradicts / incompatible_with on top of these hints.
      await this.createEdgesFromRawPayloadRefs(
        memory.object_id,
        signal,
        "supersedes_refs",
        MemoryGraphEdgeType.SUPERSEDES
      );
      await this.createEdgesFromRawPayloadRefs(
        memory.object_id,
        signal,
        "exception_to_refs",
        MemoryGraphEdgeType.EXCEPTION_TO
      );
      await this.createEdgesFromRawPayloadRefs(
        memory.object_id,
        signal,
        "contradicts_refs",
        MemoryGraphEdgeType.CONTRADICTS
      );
      await this.createEdgesFromRawPayloadRefs(
        memory.object_id,
        signal,
        "incompatible_with_refs",
        MemoryGraphEdgeType.INCOMPATIBLE_WITH
      );
      // ConflictDetectionService: rule-based + optional LLM scan for
      // memories in the same workspace that contradict / are incompatible
      // with the freshly materialized one. Edges created here complement
      // the caller-explicit hints above.
      if (this.dependencies.conflictDetectionPort !== undefined) {
        try {
          await this.dependencies.conflictDetectionPort.detectAndLinkConflicts({
            newMemoryId: memory.object_id,
            newMemoryDimension: toMemoryDimension(signal.object_kind),
            newMemoryScopeClass: toScopeClass(signal.scope_hint),
            newMemoryContent: buildDistilledFact(signal),
            newMemoryDomainTags: signal.domain_tags,
            workspaceId: signal.workspace_id,
            runId: signal.run_id
          });
        } catch (err) {
          console.warn("materialization-router: conflict detection failed", {
            memoryId: memory.object_id,
            signalId: signal.signal_id,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }

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
  private async materializeMemoryEntryOnly(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];

    try {
      const evidence = await this.dependencies.evidenceService.create(buildEvidenceInput(signal));
      createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });

      const memory = await this.dependencies.memoryService.create(buildMemoryInput(signal, [evidence.object_id]));
      createdObjects.push({ object_kind: memory.object_kind, object_id: memory.object_id });

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
   * Creates graph edges from `newObjectId` to each memory ID listed in
   * `signal.raw_payload.source_memory_refs`. Errors are silently swallowed —
   * edge creation must never block or fail a materialization.
   */
  private async createSourceMemoryEdges(
    newObjectId: string,
    signal: CandidateMemorySignal,
    edgeType: MemoryGraphEdgeTypeValue
  ): Promise<void> {
    await this.createEdgesFromRawPayloadRefs(
      newObjectId,
      signal,
      "source_memory_refs",
      edgeType
    );
  }

  // see also: createSourceMemoryEdges — same shape but variable payload key
  // and edge type. Used by materializeMemoryAndClaim to honor caller-supplied
  // supersedes / exception_to / contradicts / incompatible_with hints.
  private async createEdgesFromRawPayloadRefs(
    newObjectId: string,
    signal: CandidateMemorySignal,
    rawPayloadKey: string,
    edgeType: MemoryGraphEdgeTypeValue
  ): Promise<void> {
    if (this.dependencies.graphEdgePort === undefined) {
      return;
    }

    const rawRefs = signal.raw_payload[rawPayloadKey];
    if (!Array.isArray(rawRefs) || rawRefs.length === 0) {
      return;
    }

    for (const ref of rawRefs) {
      if (typeof ref !== "string" || ref.trim().length === 0 || ref === newObjectId) {
        continue;
      }

      try {
        await this.dependencies.graphEdgePort.createEdge({
          sourceMemoryId: newObjectId,
          targetMemoryId: ref,
          edgeType,
          workspaceId: signal.workspace_id,
          runId: signal.run_id
        });
      } catch (err) {
        console.warn("materialization-router: graph edge creation failed", {
          sourceMemoryId: newObjectId,
          targetMemoryId: ref,
          edgeType,
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
// signal by its `object_kind` so the live ontology no longer collapses
// every signal into the memory_and_claim 1:1:1 trio. Returns null when
// the object_kind is not in the diversification table — the caller then
// falls back to memory_and_claim_draft so dimensions like constraint /
// procedure / hazard / glossary / episode keep producing claims.
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
      return {
        kind: "memory_and_claim",
        route_target: "memory_and_claim_draft",
        routing_reason: `object_kind=${objectKind} -> memory_and_claim_draft (claim_status defaulted to draft by ClaimService)`
      };
    case "outcome":
    case "reference":
    case "task_state":
      return {
        kind: "evidence_only",
        route_target: "memory_entry_only",
        routing_reason: `object_kind=${objectKind} -> memory_entry_only (evidence + memory, no claim)`
      };
    default:
      return null;
  }
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
    physical_anchor: null,
    evidence_health_state: computeEvidenceHealthState(signal),
    gist: appendSummarySuffix(excerpt, summarySuffix),
    excerpt,
    source_hash: null,
    run_id: signal.run_id,
    workspace_id: signal.workspace_id,
    surface_id: signal.surface_id
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
  const refs = signal.raw_payload.supersedes_refs;
  return Array.isArray(refs) && refs.some((ref) => typeof ref === "string" && ref.trim().length > 0);
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
      return Array.isArray(signal.raw_payload?.source_memory_refs) &&
        (signal.raw_payload.source_memory_refs as unknown[]).length > 0
        ? "derived"
        : "inferred";
    case "garden_compile":
    default:
      return "extracted";
  }
}

function toClaimKind(objectKind: string): ClaimKind {
  switch (objectKind) {
    case "preference":
      return "preference";
    case "procedure":
      return "procedure";
    case "factual_policy":
      return "factual_policy";
    case "exception":
      return "exception";
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
const DISTILLED_FACT_MAX_CHARS = 280;
const DISTILLED_FACT_MAX_SENTENCES = 2;

function buildDistilledFact(signal: CandidateMemorySignal): string {
  const providedDistilled = signal.raw_payload.distilled_fact;
  if (typeof providedDistilled === "string") {
    const trimmed = providedDistilled.trim();
    if (trimmed.length > 0) {
      return trimmed.length <= DISTILLED_FACT_MAX_CHARS
        ? trimmed
        : `${trimmed.slice(0, DISTILLED_FACT_MAX_CHARS - 3)}...`;
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
