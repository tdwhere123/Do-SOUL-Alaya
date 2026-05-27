import {
  EdgeProposalTriggerSource,
  MemoryGraphEdgeType,
  type EdgeProposalTriggerSourceValue,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue
} from "@do-soul/alaya-protocol";

// invariant: ConflictDetectionService is the producer of the staged
// MemoryGraphEdge types contradicts / incompatible_with (the supersedes
// and exception_to writers live in materialization-router via
// first-class candidate signal refs). Runs at memory materialization
// time. Detection
// failures must not break a successful memory creation; the caller
// catches and warns.
// invariant: scope = HOT tier only. findByDimension on memoryRepo reads
// the hot tier index; cold/warm-tier memories do not participate in
// rule-based conflict detection. New memories never raise contradicts
// against tombstoned/archived peers — design intent because conflict
// detection costs O(workspace_size) on every materialization and only
// the live working set is recall-eligible.
// invariant: LLM fallback is bypassed when rule-based detection already
// produced at least one contradicts edge. The LLM run targets the
// ambiguous-neighborhood case where rule thresholds did not trip; it
// is not an "add a second opinion on top" path. The rule path is
// disable-able via ruleEnabled=false (constructor) or
// ALAYA_CONFLICT_RULE_ENABLED=false (env); when disabled the LLM port
// becomes the sole producer of contradicts / incompatible_with edges.

export interface ConflictDetectionMemoryRepoPort {
  findByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByWorkspaceId(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

export interface ConflictDetectionGraphPort {
  createEdge(params: {
    readonly sourceMemoryId: string;
    readonly targetMemoryId: string;
    readonly edgeType: MemoryGraphEdgeTypeValue;
    readonly workspaceId: string;
    readonly runId?: string | null;
    readonly triggerSource?: EdgeProposalTriggerSourceValue;
    readonly confidence?: number;
    readonly reason?: string | null;
  }): Promise<void>;
}

export interface ConflictDetectionLlmPort {
  classifyPair(input: {
    readonly newContent: string;
    readonly existingContent: string;
    readonly dimension: string;
    readonly scopeClass: string;
  }): Promise<"contradicts" | "incompatible_with" | "none">;
}

// invariant: see also: DynamicsService.emitKarmaEvent — the
// supersede_penalty karma kind fires from this service whenever a new
// memory is linked to an existing peer via the CONTRADICTS edge. The
// target_memory_id (the older peer) takes the penalty because the new
// memory is the supersede candidate.
export interface ConflictDetectionKarmaEmitterPort {
  emitKarmaEvent(input: {
    readonly kind: "supersede_penalty";
    readonly objectId: string;
    readonly workspaceId: string;
  }): Promise<void>;
}

export interface ConflictDetectionServiceDeps {
  readonly memoryRepo: ConflictDetectionMemoryRepoPort;
  readonly graphEdgePort: ConflictDetectionGraphPort;
  readonly llmPort?: ConflictDetectionLlmPort;
  readonly karmaEmitter?: ConflictDetectionKarmaEmitterPort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly llmMaxPairsPerNewMemory?: number;
  readonly ruleEnabled?: boolean;
}

// Rule-based comparator constants. Values tuned for short distilled facts
// (≤ DISTILLED_FACT_MAX_CHARS per buildDistilledFact). High tag overlap + low content
// overlap = contradicts. Cross-scope or cross-dimension classification
// is reported by the caller before invoking; this service refines on
// content evidence within the same dimension.
// invariant: TAG_OVERLAP_CONTRADICTS_THRESHOLD is the rule-path gate for
// when two same-dimension memories are "about the same thing" enough to
// even be a contradicts candidate. The 0.35 value (down from 0.5) is the
// v0.3.11 §C C3 setting: shorter distilled facts carry fewer tags, so
// the prior 0.5 floor rejected real contradicts where the new and old
// fact each carried two tags with only one in common (overlap=1/3 ≈
// 0.33). At 0.35 the rule path also lets the {coffee,alpha} vs
// {coffee,beta} ambiguous-band case through, while still rejecting
// single-tag drive-bys (1/N where N≥3) — those flow to the LLM ambiguous
// path when enabled. Writes still go through proposeEdge so a stricter
// reviewer or auto-accept policy is the final gate, not this constant.
const TAG_OVERLAP_CONTRADICTS_THRESHOLD = 0.35;
const TOKEN_JACCARD_CONTRADICTS_MAX = 0.35;
const DEFAULT_LLM_MAX_PAIRS = 4;

export class ConflictDetectionService {
  private readonly ruleEnabled: boolean;

  public constructor(private readonly deps: ConflictDetectionServiceDeps) {
    this.ruleEnabled = deps.ruleEnabled ?? true;
  }

  public async detectAndLinkConflicts(params: {
    readonly newMemoryId: string;
    readonly newMemoryDimension: string;
    readonly newMemoryScopeClass: string;
    readonly newMemoryContent: string;
    readonly newMemoryDomainTags: readonly string[];
    readonly workspaceId: string;
    readonly runId: string;
  }): Promise<void> {
    // invariant: short-circuit when neither writer can fire. With
    // ruleEnabled=false and no LLM port, both the O(workspace_size)
    // findByDimension + findByWorkspaceId fetches would be pure waste.
    if (!this.ruleEnabled && this.deps.llmPort === undefined) {
      return;
    }
    const sameDimension = await this.deps.memoryRepo
      .findByDimension(params.workspaceId, params.newMemoryDimension as MemoryEntry["dimension"])
      .catch((err) => {
        this.warn("memoryRepo.findByDimension failed", {
          workspace_id: params.workspaceId,
          error: errorMessage(err)
        });
        return [] as readonly Readonly<MemoryEntry>[];
      });
    const allWorkspace = await this.deps.memoryRepo
      .findByWorkspaceId(params.workspaceId)
      .catch((err) => {
        this.warn("memoryRepo.findByWorkspaceId failed", {
          workspace_id: params.workspaceId,
          error: errorMessage(err)
        });
        return [] as readonly Readonly<MemoryEntry>[];
      });

    const newTokens = tokenize(params.newMemoryContent);
    const newTagSet = new Set(params.newMemoryDomainTags);

    const contradictsCandidates: Array<Readonly<MemoryEntry>> = [];

    if (this.ruleEnabled) {
      for (const existing of sameDimension) {
        if (existing.object_id === params.newMemoryId) {
          continue;
        }
        if (existing.scope_class !== params.newMemoryScopeClass) {
          continue;
        }
        const existingTagSet = new Set(existing.domain_tags);
        const tagOverlap = jaccardIndex(newTagSet, existingTagSet);
        if (tagOverlap < TAG_OVERLAP_CONTRADICTS_THRESHOLD) {
          continue;
        }
        const existingTokens = tokenize(existing.content);
        const tokenOverlap = jaccardIndex(newTokens, existingTokens);
        if (tokenOverlap >= TOKEN_JACCARD_CONTRADICTS_MAX) {
          continue;
        }
        contradictsCandidates.push(existing);
      }

      for (const existing of contradictsCandidates) {
        await this.writeEdge(
          params.newMemoryId,
          existing.object_id,
          MemoryGraphEdgeType.CONTRADICTS,
          params.workspaceId,
          params.runId
        );
      }

      for (const existing of allWorkspace) {
        if (existing.object_id === params.newMemoryId) {
          continue;
        }
        const dimMismatch = existing.dimension !== params.newMemoryDimension;
        const scopeMismatch = existing.scope_class !== params.newMemoryScopeClass;
        if (!dimMismatch && !scopeMismatch) {
          continue;
        }
        const existingTagSet = new Set(existing.domain_tags);
        const tagOverlap = jaccardIndex(newTagSet, existingTagSet);
        if (tagOverlap < TAG_OVERLAP_CONTRADICTS_THRESHOLD) {
          continue;
        }
        await this.writeEdge(
          params.newMemoryId,
          existing.object_id,
          MemoryGraphEdgeType.INCOMPATIBLE_WITH,
          params.workspaceId,
          params.runId
        );
      }
    }

    if (this.deps.llmPort !== undefined && contradictsCandidates.length === 0) {
      const maxPairs = this.deps.llmMaxPairsPerNewMemory ?? DEFAULT_LLM_MAX_PAIRS;
      const ambiguousNeighbors = sameDimension
        .filter((existing) => existing.object_id !== params.newMemoryId)
        .filter((existing) => existing.scope_class === params.newMemoryScopeClass)
        .filter((existing) => {
          const existingTagSet = new Set(existing.domain_tags);
          const overlap = jaccardIndex(newTagSet, existingTagSet);
          return overlap >= TAG_OVERLAP_CONTRADICTS_THRESHOLD * 0.5;
        })
        .slice(0, maxPairs);
      for (const candidate of ambiguousNeighbors) {
        try {
          const verdict = await this.deps.llmPort.classifyPair({
            newContent: params.newMemoryContent,
            existingContent: candidate.content,
            dimension: params.newMemoryDimension,
            scopeClass: params.newMemoryScopeClass
          });
          if (verdict === "contradicts") {
            await this.writeEdge(
              params.newMemoryId,
              candidate.object_id,
              MemoryGraphEdgeType.CONTRADICTS,
              params.workspaceId,
              params.runId
            );
          } else if (verdict === "incompatible_with") {
            await this.writeEdge(
              params.newMemoryId,
              candidate.object_id,
              MemoryGraphEdgeType.INCOMPATIBLE_WITH,
              params.workspaceId,
              params.runId
            );
          }
        } catch (err) {
          this.warn("conflict detection llm pair classify failed", {
            new_memory_id: params.newMemoryId,
            existing_memory_id: candidate.object_id,
            error: errorMessage(err)
          });
        }
      }
    }
  }

  private async writeEdge(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string,
    runId: string
  ): Promise<void> {
    try {
      await this.deps.graphEdgePort.createEdge({
        sourceMemoryId,
        targetMemoryId,
        edgeType,
        workspaceId,
        runId,
        triggerSource: EdgeProposalTriggerSource.CONFLICT_DETECTION,
        confidence: 0.5,
        reason: "conflict detection derived edge proposal"
      });
    } catch (err) {
      this.warn("conflict detection edge create failed", {
        source_memory_id: sourceMemoryId,
        target_memory_id: targetMemoryId,
        edge_type: edgeType,
        workspace_id: workspaceId,
        error: errorMessage(err)
      });
      return;
    }

    if (edgeType === MemoryGraphEdgeType.CONTRADICTS && this.deps.karmaEmitter !== undefined) {
      try {
        await this.deps.karmaEmitter.emitKarmaEvent({
          kind: "supersede_penalty",
          objectId: targetMemoryId,
          workspaceId
        });
      } catch (err) {
        this.warn("supersede_penalty karma emit failed", {
          target_memory_id: targetMemoryId,
          workspace_id: workspaceId,
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

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length >= 2)
  );
}

function jaccardIndex(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
