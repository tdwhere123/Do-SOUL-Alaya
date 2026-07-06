import {
  MemoryGraphEdgeType,
  type MemoryGraphEdgeTypeValue,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  type PathMintOutcome,
} from "../../path-graph/edge-proposals/path-relation-proposal-service.js";
import { CoreError } from "../../shared/errors.js";
import {
  DEFAULT_LLM_MAX_PAIRS,
  TAG_OVERLAP_CONTRADICTS_THRESHOLD,
  TOKEN_JACCARD_CONTRADICTS_MAX,
  errorMessage,
  jaccardIndex,
  negativeProfileForEdgeType,
  readConflictDimensionCandidates,
  tokenize,
  type ConflictDetectionServiceDeps,
  type ConflictVerdictSource
} from "./conflict-detection-service-shared.js";
export type {
  ConflictDetectionKarmaEmitterPort,
  ConflictDetectionLlmPort,
  ConflictDetectionMemoryRepoPort,
  ConflictDetectionServiceDeps
} from "./conflict-detection-service-shared.js";

interface ConflictDetectionRequest {
  readonly newMemoryId: string;
  readonly newMemoryDimension: string;
  readonly newMemoryScopeClass: string;
  readonly newMemoryContent: string;
  readonly newMemoryDomainTags: readonly string[];
  readonly workspaceId: string;
  readonly runId: string;
  readonly strictNoDrop?: boolean;
}

interface ConflictCandidateContext {
  readonly sameDimension: readonly Readonly<MemoryEntry>[];
  readonly sharedTagCandidates: readonly Readonly<MemoryEntry>[];
  readonly newTokens: ReadonlySet<string>;
  readonly newTagSet: ReadonlySet<string>;
}

export class ConflictDetectionService {
  private readonly ruleEnabled: boolean;

  public constructor(private readonly deps: ConflictDetectionServiceDeps) {
    this.ruleEnabled = deps.ruleEnabled ?? true;
  }

  public async detectAndLinkConflicts(params: ConflictDetectionRequest): Promise<void> {
    const strictNoDrop = params.strictNoDrop ?? false;
    if (!this.ruleEnabled && this.deps.llmPort === undefined) {
      return;
    }
    const context = await this.loadConflictCandidateContext(params, strictNoDrop);
    const contradictsCandidates = this.ruleEnabled
      ? await this.linkRuleDetectedConflicts(params, context, strictNoDrop)
      : [];
    if (this.deps.llmPort !== undefined && contradictsCandidates.length === 0) {
      await this.linkLlmDetectedConflicts(params, context, strictNoDrop);
    }
  }

  private async loadConflictCandidateContext(
    params: ConflictDetectionRequest,
    strictNoDrop: boolean
  ): Promise<ConflictCandidateContext> {
    const sameDimension = await this.fetchCandidates(
      () =>
        readConflictDimensionCandidates(
          this.deps.memoryRepo,
          params.workspaceId,
          params.newMemoryDimension as MemoryEntry["dimension"]
        ),
      "memoryRepo.findByDimension failed",
      params.workspaceId,
      strictNoDrop
    );
    // INCOMPATIBLE_WITH candidate narrowing: the gate keeps a peer only if
    // jaccard(domain_tags) >= TAG_OVERLAP_CONTRADICTS_THRESHOLD, which
    // requires >=1 shared tag, so the shared-tag set is a superset of every
    // gate-passing peer. Fetching it instead of the full workspace yields
    // identical edges with a sub-linear candidate set. Only the rule path
    // reads it; skip the fetch entirely when the rule path is disabled.
    const sharedTagCandidates = this.ruleEnabled
      ? await this.fetchCandidates(
          () =>
            this.deps.memoryRepo.findBySharedDomainTags(
              params.workspaceId,
              params.newMemoryDomainTags
            ),
          "memoryRepo.findBySharedDomainTags failed",
          params.workspaceId,
          strictNoDrop
        )
      : ([] as readonly Readonly<MemoryEntry>[]);
    return Object.freeze({
      sameDimension,
      sharedTagCandidates,
      newTokens: tokenize(params.newMemoryContent),
      newTagSet: new Set(params.newMemoryDomainTags)
    });
  }

  private async linkRuleDetectedConflicts(
    params: ConflictDetectionRequest,
    context: ConflictCandidateContext,
    strictNoDrop: boolean
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const contradictsCandidates = context.sameDimension.filter((existing) =>
      isRuleContradictsCandidate(params, context, existing)
    );
    for (const existing of contradictsCandidates) {
      await this.writeEdge(params.newMemoryId, existing.object_id, MemoryGraphEdgeType.CONTRADICTS, params.workspaceId, params.runId, "rule", strictNoDrop);
    }
    for (const existing of context.sharedTagCandidates) {
      if (!isRuleIncompatibleCandidate(params, context, existing)) {
        continue;
      }
      await this.writeEdge(params.newMemoryId, existing.object_id, MemoryGraphEdgeType.INCOMPATIBLE_WITH, params.workspaceId, params.runId, "rule", strictNoDrop);
    }
    return Object.freeze(contradictsCandidates);
  }

  private async linkLlmDetectedConflicts(
    params: ConflictDetectionRequest,
    context: ConflictCandidateContext,
    strictNoDrop: boolean
  ): Promise<void> {
    const maxPairs = this.deps.llmMaxPairsPerNewMemory ?? DEFAULT_LLM_MAX_PAIRS;
    const ambiguousNeighbors = selectAmbiguousLlmNeighbors(params, context, maxPairs);
    for (const candidate of ambiguousNeighbors) {
      await this.linkSingleLlmCandidate(params, candidate, strictNoDrop);
    }
  }

  private async linkSingleLlmCandidate(
    params: ConflictDetectionRequest,
    candidate: Readonly<MemoryEntry>,
    strictNoDrop: boolean
  ): Promise<void> {
    try {
      const verdict = await this.deps.llmPort!.classifyPair({
        newContent: params.newMemoryContent,
        existingContent: candidate.content,
        dimension: params.newMemoryDimension,
        scopeClass: params.newMemoryScopeClass
      });
      if (verdict === "contradicts" || verdict === "incompatible_with") {
        await this.writeEdge(params.newMemoryId, candidate.object_id, verdict, params.workspaceId, params.runId, "llm", strictNoDrop);
      }
    } catch (err) {
      if (strictNoDrop) {
        throw err;
      }
      this.warn("conflict detection llm pair classify failed", {
        new_memory_id: params.newMemoryId,
        existing_memory_id: candidate.object_id,
        error: errorMessage(err)
      });
    }
  }

  // invariant: candidate-query fetch with mode-dependent failure handling.
  // In strict no-drop mode a repository throw rethrows so the bulk-enrich
  // worker releases the claim (a query failure must NOT silently become an
  // empty candidate set, dropping every owed conflict edge for this memory).
  // In best-effort inline mode it warns and degrades to an empty set, keeping
  // a detection failure from breaking a successful memory creation.
  private async fetchCandidates(
    fetch: () => Promise<readonly Readonly<MemoryEntry>[]>,
    warnMessage: string,
    workspaceId: string,
    strictNoDrop: boolean
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      return await fetch();
    } catch (err) {
      if (strictNoDrop) {
        throw err;
      }
      this.warn(warnMessage, {
        workspace_id: workspaceId,
        error: errorMessage(err)
      });
      return [] as readonly Readonly<MemoryEntry>[];
    }
  }

  private async writeEdge(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string,
    runId: string,
    verdictSource: ConflictVerdictSource,
    strictNoDrop: boolean
  ): Promise<void> {
    const outcome = await this.submitConflictPathCandidate(
      sourceMemoryId,
      targetMemoryId,
      edgeType,
      workspaceId,
      runId,
      verdictSource,
      strictNoDrop
    );
    if (outcome === "failed") {
      this.handlePathMintFailure(sourceMemoryId, targetMemoryId, edgeType, workspaceId, verdictSource, strictNoDrop);
      return;
    }
    if (outcome === "rejected") {
      return;
    }
    await this.emitTrustedSupersedePenalty(sourceMemoryId, targetMemoryId, edgeType, workspaceId, runId, verdictSource);
  }

  private async submitConflictPathCandidate(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string,
    runId: string,
    verdictSource: ConflictVerdictSource,
    strictNoDrop: boolean
  ): Promise<PathMintOutcome> {
    const profile = negativeProfileForEdgeType(edgeType, verdictSource);
    try {
      return await this.deps.pathCandidatePort.submitCandidate({
        workspaceId,
        sourceAnchor: { kind: "object", object_id: sourceMemoryId },
        targetAnchor: { kind: "object", object_id: targetMemoryId },
        relationKind: profile.relationKind,
        initialStrength: profile.initialStrength,
        governanceClass: profile.governanceClass,
        evidenceBasis: profile.evidenceBasis,
        recallBiasSign: profile.recallBiasSign,
        recallBiasMagnitude: profile.recallBiasMagnitude,
        why: [`conflict detection ${profile.relationKind} candidate`, `verdict=${verdictSource}`, `run=${runId}`]
      });
    } catch (err) {
      this.handlePathMintException(sourceMemoryId, targetMemoryId, edgeType, workspaceId, verdictSource, strictNoDrop, err);
      return "failed";
    }
  }

  private handlePathMintException(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string,
    verdictSource: ConflictVerdictSource,
    strictNoDrop: boolean,
    err: unknown
  ): void {
    if (strictNoDrop) {
      throw new CoreError("OBLIGATION_VIOLATION", `Conflict detection path candidate failed transiently: ${sourceMemoryId}->${targetMemoryId}`, { cause: err });
    }
    this.warnPathMintFailure(sourceMemoryId, targetMemoryId, edgeType, workspaceId, verdictSource, errorMessage(err));
  }

  private handlePathMintFailure(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string,
    verdictSource: ConflictVerdictSource,
    strictNoDrop: boolean
  ): void {
    if (strictNoDrop) {
      throw new CoreError("OBLIGATION_VIOLATION", `Conflict detection path candidate failed transiently: ${sourceMemoryId}->${targetMemoryId}`);
    }
    this.warnPathMintFailure(sourceMemoryId, targetMemoryId, edgeType, workspaceId, verdictSource, "submitCandidate returned failed");
  }

  private warnPathMintFailure(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string,
    verdictSource: ConflictVerdictSource,
    error: string
  ): void {
    this.warn("conflict detection edge create failed", {
      source_memory_id: sourceMemoryId,
      target_memory_id: targetMemoryId,
      edge_type: edgeType,
      verdict_source: verdictSource,
      workspace_id: workspaceId,
      error
    });
  }

  private async emitTrustedSupersedePenalty(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string,
    runId: string,
    verdictSource: ConflictVerdictSource
  ): Promise<void> {
    if (
      verdictSource === "llm" &&
      edgeType === MemoryGraphEdgeType.CONTRADICTS &&
      this.deps.karmaEmitter !== undefined
    ) {
      try {
        await this.deps.karmaEmitter.emitKarmaEvent({
          kind: "supersede_penalty",
          objectId: targetMemoryId,
          supersedingObjectId: sourceMemoryId,
          workspaceId,
          runId
        });
      } catch (err) {
        this.warn("supersede_penalty karma emit failed", {
          target_memory_id: targetMemoryId,
          workspace_id: workspaceId,
          source_memory_id: sourceMemoryId,
          error: errorMessage(err)
        });
      }
    }
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    if (this.deps.warn !== undefined) {
      this.deps.warn(message, meta);
    }
  }
}

function isRuleContradictsCandidate(
  params: ConflictDetectionRequest,
  context: ConflictCandidateContext,
  existing: Readonly<MemoryEntry>
): boolean {
  if (existing.object_id === params.newMemoryId || existing.scope_class !== params.newMemoryScopeClass) {
    return false;
  }
  const tagOverlap = jaccardIndex(context.newTagSet, new Set(existing.domain_tags));
  if (tagOverlap < TAG_OVERLAP_CONTRADICTS_THRESHOLD) {
    return false;
  }
  return jaccardIndex(context.newTokens, tokenize(existing.content)) < TOKEN_JACCARD_CONTRADICTS_MAX;
}

function isRuleIncompatibleCandidate(
  params: ConflictDetectionRequest,
  context: ConflictCandidateContext,
  existing: Readonly<MemoryEntry>
): boolean {
  if (existing.object_id === params.newMemoryId) {
    return false;
  }
  const dimMismatch = existing.dimension !== params.newMemoryDimension;
  const scopeMismatch = existing.scope_class !== params.newMemoryScopeClass;
  if (!dimMismatch && !scopeMismatch) {
    return false;
  }
  return jaccardIndex(context.newTagSet, new Set(existing.domain_tags)) >= TAG_OVERLAP_CONTRADICTS_THRESHOLD;
}

function selectAmbiguousLlmNeighbors(
  params: ConflictDetectionRequest,
  context: ConflictCandidateContext,
  maxPairs: number
): readonly Readonly<MemoryEntry>[] {
  return context.sameDimension
    .filter((existing) => existing.object_id !== params.newMemoryId)
    .filter((existing) => existing.scope_class === params.newMemoryScopeClass)
    .filter((existing) =>
      jaccardIndex(context.newTagSet, new Set(existing.domain_tags)) >= TAG_OVERLAP_CONTRADICTS_THRESHOLD * 0.5
    )
    .slice(0, maxPairs);
}

// invariant: the rule path is a pure same-dimension Jaccard heuristic
// whose hit conditions (tag overlap + low token overlap) are entirely
// agent-controllable content. A rule verdict is therefore a WEAK claim,
// not a system-derived ruling: it seeds attention_only at low strength
// (recall_bias - preserved so plasticity still classifies it negative) and
// must earn recall eligibility through PathPlasticityService — it never
// mints a recall_allowed negative path and never fires supersede_penalty
// karma. This mirrors edge-auto-producer's LOCAL_SUPERSEDES_SEED_PROFILE.
// The recall_allowed/0.9 band is reserved for the LLM-verdict path, which
// the system computed itself.
// see also: edge-auto-producer-service.ts LOCAL_SUPERSEDES_SEED_PROFILE.
