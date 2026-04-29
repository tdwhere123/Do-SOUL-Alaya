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
  type EvidenceCapsule,
  type EvidenceHealthState as EvidenceHealthStateValue,
  type FormationKind,
  type MemoryDimension as MemoryDimensionValue,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue,
  type OriginTier,
  type ScopeClass as ScopeClassValue,
  type SourceKind as SourceKindValue,
  type SynthesisCapsule,
  type SynthesisType
} from "@do-soul/alaya-protocol";
import {
  type HandoffGapCreatedObject,
  type HandoffGapHandler
} from "./handoff-gap-handler.js";

export interface MaterializationTarget {
  readonly kind: "memory_and_claim" | "synthesis" | "handoff_gap" | "evidence_only" | "deferred";
  readonly routing_reason: string;
}

export interface MaterializationResult {
  readonly signal_id: string;
  readonly target_kind: MaterializationTarget["kind"];
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

export interface MaterializationRouterDeps {
  readonly evidenceService: EvidenceMaterializationPort;
  readonly memoryService: MemoryMaterializationPort;
  readonly synthesisService: SynthesisMaterializationPort;
  readonly claimService: ClaimMaterializationPort;
  readonly handoffGapHandler: HandoffGapHandler;
  readonly graphEdgePort?: GraphEdgeCreationPort;
}

export class MaterializationRouter {
  private readonly handoffGapHandler: HandoffGapHandler;

  public constructor(private readonly dependencies: MaterializationRouterDeps) {
    this.handoffGapHandler = dependencies.handoffGapHandler;
  }

  public route(signal: CandidateMemorySignal): MaterializationTarget {
    if (
      (signal.signal_kind === "potential_claim" || signal.signal_kind === "potential_preference") &&
      signal.confidence >= 0.5
    ) {
      return {
        kind: "memory_and_claim",
        routing_reason:
          signal.evidence_refs.length >= 1
            ? "reusable signal with evidence support"
            : "high-confidence preference/claim — evidence created during materialization"
      };
    }

    if (signal.signal_kind === "potential_synthesis" && signal.evidence_refs.length >= 2) {
      return {
        kind: "synthesis",
        routing_reason: "multi-evidence synthesis candidate"
      };
    }

    if (signal.signal_kind === "potential_handoff") {
      return {
        kind: "handoff_gap",
        routing_reason: "run-bound handoff/gap detection"
      };
    }

    if (signal.signal_kind === "potential_evidence_anchor") {
      return {
        kind: "evidence_only",
        routing_reason: "evidence archival"
      };
    }

    // Low-confidence unroutable signals are deferred rather than persisted as
    // questionable evidence — avoids accumulating low-confidence noise (F9 / doc §77).
    if (signal.confidence < 0.3) {
      return {
        kind: "deferred",
        routing_reason: "uncertain signal — deferred pending higher-confidence reconfirmation"
      };
    }

    return {
      kind: "evidence_only",
      // Unroutable signals are archived as questionable evidence only; they do not
      // produce verified long-term objects (invariant #16).
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
      await this.createSourceMemoryEdges(
        memory.object_id,
        signal,
        MemoryGraphEdgeType.DERIVES_FROM
      );

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
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

      // Create derives_from edges to any memory IDs the model tagged in raw_payload.source_memory_refs.
      await this.createSourceMemoryEdges(
        synthesis.object_id,
        signal,
        MemoryGraphEdgeType.DERIVES_FROM
      );

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
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
        routing_reason: target.routing_reason,
        created_objects: [createdObject],
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
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
      target_kind: target.kind,
      routing_reason: target.routing_reason,
      created_objects: [],
      success: true
    };
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
    if (this.dependencies.graphEdgePort === undefined) {
      return;
    }

    const rawRefs = signal.raw_payload["source_memory_refs"];
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
        // Fire-and-forget: graph edges are supplementary, not critical.
        // Log so synthesis derives_from failures are visible in production.
        console.warn("materialization-router: graph edge creation failed", {
          sourceMemoryId: newObjectId,
          targetMemoryId: ref,
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
        routing_reason: target.routing_reason,
        created_objects: [{ object_kind: evidence.object_kind, object_id: evidence.object_id }],
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        routing_reason: target.routing_reason,
        created_objects: [],
        success: false,
        error: readErrorMessage(error)
      };
    }
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

function buildEvidenceInput(
  signal: CandidateMemorySignal,
  summarySuffix?: string
): EvidenceMaterializationInput {
  const excerpt = buildSignalSummary(signal);

  return {
    created_by: signal.source,
    evidence_kind: "inferred",
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
    formation_kind: toFormationKind(signal.source),
    scope_class: toScopeClass(signal.scope_hint),
    content: buildSignalSummary(signal),
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

  return {
    created_by: signal.source,
    governance_subject_domain: `signal.${signal.object_kind}`,
    governance_subject_qualifiers: {
      workspace: signal.workspace_id,
      run: signal.run_id
    },
    claim_kind: claimKind,
    scope_class: toScopeClass(signal.scope_hint),
    enforcement_level: claimKind === "constraint" || claimKind === "factual_policy" ? "strict" : "preferred",
    origin_tier: toOriginTier(signal.source),
    precedence_basis: "evidence_strength",
    proposition_digest: buildSignalSummary(signal),
    evidence_refs: evidenceRefs,
    source_object_refs: sourceObjectRefs,
    workspace_id: signal.workspace_id
  };
}

function buildSynthesisInput(
  signal: CandidateMemorySignal,
  evidenceRefs: readonly string[]
): SynthesisMaterializationInput {
  return {
    created_by: signal.source,
    topic_key: buildTopicKey(signal),
    synthesis_type: toSynthesisType(),
    summary: buildSignalSummary(signal),
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

function toFormationKind(source: CandidateMemorySignal["source"]): FormationKind {
  switch (source) {
    case "user_seed":
      return "explicit";
    case "import":
      return "imported";
    case "model_tool":
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
