import {
  MemoryGraphEdgeType,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue
} from "@do-soul/alaya-protocol";
import {
  CONTRADICTS_SEED_PROFILE,
  INCOMPATIBLE_SEED_PROFILE,
  type PathMintOutcome,
  type PathSeedProfile
} from "./path-graph/path-relation-proposal-service.js";
import type { PathCandidateSink } from "./path-graph/path-candidate-sink.js";
import { CoreError } from "./errors.js";

// invariant: the trust tier of a conflict verdict. "rule" is the
// agent-controllable Jaccard heuristic (weak, attention_only, no karma);
// "llm" is the system-computed classifier verdict (recall_allowed/0.9,
// fires supersede_penalty karma). writeEdge takes this so a single writer
// cannot silently grant the rule path the LLM path's trust.
type ConflictVerdictSource = "rule" | "llm";

// invariant: ConflictDetectionService is the producer of the negative
// lifecycle path families contradicts / incompatible_with (the supersedes
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
  // invariant: the INCOMPATIBLE_WITH scan candidate source. The gate
  // requires jaccard(domain_tags) >= TAG_OVERLAP_CONTRADICTS_THRESHOLD,
  // which implies the candidate shares >=1 of the new memory's
  // domain_tags. So the shared-tag set is a strict SUPERSET of every
  // gate-passing peer: scanning it instead of the full workspace yields
  // byte-identical INCOMPATIBLE_WITH edges with a sub-linear candidate
  // set. A new memory with zero tags has no shared-tag candidates, which
  // also matches the full scan (jaccard with an empty set is 0 < 0.35).
  findBySharedDomainTags(
    workspaceId: string,
    tags: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

// invariant: conflict-detection sink is the governed negative-family path
// candidate intake (PathCandidateSink), not memory_graph_edges. A
// contradicts/incompatible_with candidate is born with recall_bias -
// (suppresses recall, never drops graph_support below baseline) and runs
// the unified plasticity model. Trust is tiered by verdict source: the
// LLM verdict seeds recall_allowed/0.9 and fires the karma supersede
// signal alongside; the agent-controllable rule heuristic seeds
// attention_only/0.5 and fires NO karma.
// see also: path-candidate-sink.ts PathCandidateSink — the shared port.

export interface ConflictDetectionLlmPort {
  classifyPair(input: {
    readonly newContent: string;
    readonly existingContent: string;
    readonly dimension: string;
    readonly scopeClass: string;
  }): Promise<"contradicts" | "incompatible_with" | "none">;
}

// invariant: see also: DynamicsService.emitKarmaEvent — the
// supersede_penalty karma kind fires from this service only on an
// LLM-verdict CONTRADICTS link, never on a rule-heuristic hit. The
// target_memory_id (the older peer) takes the penalty because the new
// memory is the supersede candidate. The rule path is omitted because its
// hit conditions are agent-controllable content.
export interface ConflictDetectionKarmaEmitterPort {
  emitKarmaEvent(input: {
    readonly kind: "supersede_penalty";
    readonly objectId: string;
    readonly workspaceId: string;
    readonly runId?: string | null;
  }): Promise<void>;
}

export interface ConflictDetectionServiceDeps {
  readonly memoryRepo: ConflictDetectionMemoryRepoPort;
  readonly pathCandidatePort: PathCandidateSink;
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
// even be a contradicts candidate. 0.35 (down from a prior 0.5) is set
// because shorter distilled facts carry fewer tags: the 0.5 floor
// rejected real contradicts where the new and old fact each carried
// two tags with only one in common (overlap=1/3 ≈ 0.33). At 0.35 the
// rule path also lets the {coffee,alpha} vs {coffee,beta}
// ambiguous-band case through, while still rejecting single-tag
// drive-bys (1/N where N≥3) — those flow to the LLM ambiguous path
// when enabled. invariant: a rule hit does not write durable truth — it
// submits to PathCandidateSink in a verdict-tiered birth band. A RULE
// verdict is born attention_only (not recall-eligible at birth, earns
// recall only via plasticity), so a generous threshold cannot inject a
// recall-eligible suppression. The LLM verdict is born recall_allowed/0.9
// (recall-eligible negative/suppressive judgment, recallBiasSign -1),
// bounded by the auto-build ceiling + EventLog audit and carrying no
// review gate, because the system computed that classification itself.
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
    // invariant: strict no-drop mode for the bulk-enrich worker. When true,
    // a candidate-query failure and a transient path-mint "failed" both throw
    // instead of degrading to an empty candidate set / swallowed warn, so the
    // worker releases the enrich claim and a later cycle retries. Default
    // false preserves the best-effort inline-materialization contract (a
    // detection failure must never break a successful memory creation).
    readonly strictNoDrop?: boolean;
  }): Promise<void> {
    const strictNoDrop = params.strictNoDrop ?? false;
    // invariant: short-circuit when neither writer can fire. With
    // ruleEnabled=false and no LLM port, both the findByDimension +
    // findBySharedDomainTags fetches would be pure waste.
    if (!this.ruleEnabled && this.deps.llmPort === undefined) {
      return;
    }
    const sameDimension = await this.fetchCandidates(
      () =>
        this.deps.memoryRepo.findByDimension(
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
          params.runId,
          "rule",
          strictNoDrop
        );
      }

      for (const existing of sharedTagCandidates) {
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
          params.runId,
          "rule",
          strictNoDrop
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
              params.runId,
              "llm",
              strictNoDrop
            );
          } else if (verdict === "incompatible_with") {
            await this.writeEdge(
              params.newMemoryId,
              candidate.object_id,
              MemoryGraphEdgeType.INCOMPATIBLE_WITH,
              params.workspaceId,
              params.runId,
              "llm",
              strictNoDrop
            );
          }
        } catch (err) {
          // invariant: in strict no-drop mode a transient path-mint failure
          // rethrown by writeEdge must propagate so the worker releases the
          // claim — it is NOT a per-pair classify failure to swallow. An LLM
          // classify throw is still warn-and-continue in both modes (the
          // verdict is best-effort; a missing verdict drops no owed path).
          if (strictNoDrop && err instanceof CoreError && err.code === "OBLIGATION_VIOLATION") {
            throw err;
          }
          this.warn("conflict detection llm pair classify failed", {
            new_memory_id: params.newMemoryId,
            existing_memory_id: candidate.object_id,
            error: errorMessage(err)
          });
        }
      }
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
    const profile = negativeProfileForEdgeType(edgeType, verdictSource);
    let outcome: PathMintOutcome;
    try {
      outcome = await this.deps.pathCandidatePort.submitCandidate({
        workspaceId,
        sourceAnchor: { kind: "object", object_id: sourceMemoryId },
        targetAnchor: { kind: "object", object_id: targetMemoryId },
        relationKind: profile.relationKind,
        initialStrength: profile.initialStrength,
        governanceClass: profile.governanceClass,
        evidenceBasis: profile.evidenceBasis,
        recallBiasSign: profile.recallBiasSign,
        recallBiasMagnitude: profile.recallBiasMagnitude,
        why: [
          `conflict detection ${profile.relationKind} candidate`,
          `verdict=${verdictSource}`,
          `run=${runId}`
        ]
      });
    } catch (err) {
      // submitCandidate is contracted to catch its own materialize errors and
      // return "failed"; a thrown error is treated as the same transient class.
      if (strictNoDrop) {
        throw new CoreError(
          "OBLIGATION_VIOLATION",
          `Conflict detection path candidate failed transiently: ${sourceMemoryId}->${targetMemoryId}`,
          { cause: err }
        );
      }
      this.warn("conflict detection edge create failed", {
        source_memory_id: sourceMemoryId,
        target_memory_id: targetMemoryId,
        edge_type: edgeType,
        verdict_source: verdictSource,
        workspace_id: workspaceId,
        error: errorMessage(err)
      });
      return;
    }

    // invariant: a transient "failed" outcome owes a path. In strict no-drop
    // mode it must surface so the bulk-enrich worker releases the claim; in
    // best-effort inline mode it is warn-and-continue. A permanent "rejected"
    // (bad anchor) and the success outcomes never block — retrying a rejected
    // candidate cannot help, and applied / already_present settle the owed path.
    if (outcome === "failed") {
      if (strictNoDrop) {
        throw new CoreError(
          "OBLIGATION_VIOLATION",
          `Conflict detection path candidate failed transiently: ${sourceMemoryId}->${targetMemoryId}`
        );
      }
      this.warn("conflict detection edge create failed", {
        source_memory_id: sourceMemoryId,
        target_memory_id: targetMemoryId,
        edge_type: edgeType,
        verdict_source: verdictSource,
        workspace_id: workspaceId,
        error: "submitCandidate returned failed"
      });
      return;
    }
    if (outcome === "rejected") {
      // Permanent anchor refusal: no path, no karma. Audited by the path
      // service's path.relation_rejected event; nothing is owed here.
      return;
    }

    // invariant: supersede_penalty karma is strength-gated to the LLM
    // verdict only. The rule path is an agent-controllable Jaccard
    // heuristic; firing durable -0.2 karma against the victim on a
    // rule hit would let an agent program a contradicts match to demote a
    // peer's retention/activation score. Only the system-computed LLM
    // verdict carries enough trust to write the karma penalty.
    if (
      verdictSource === "llm" &&
      edgeType === MemoryGraphEdgeType.CONTRADICTS &&
      this.deps.karmaEmitter !== undefined
    ) {
      try {
        await this.deps.karmaEmitter.emitKarmaEvent({
          kind: "supersede_penalty",
          objectId: targetMemoryId,
          workspaceId,
          runId
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
const RULE_CONTRADICTS_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "contradicts",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.4,
  evidenceBasis: Object.freeze(["contradiction_evidence"]) as readonly string[]
});

const RULE_INCOMPATIBLE_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "incompatible_with",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.3,
  evidenceBasis: Object.freeze(["incompatibility_evidence"]) as readonly string[]
});

// invariant: maps the edge-type + verdict source to its negative
// lifecycle seed profile (recall_bias -). contradicts and
// incompatible_with are the only two this service mints; an unexpected
// type defaults to contradicts so a mis-tuned caller still gets a
// governed negative path, never a silent drop. verdictSource selects the
// trust tier: "llm" → the shared recall_allowed/0.9 core profile; "rule"
// → the weak attention_only/0.5 local profile.
function negativeProfileForEdgeType(
  edgeType: MemoryGraphEdgeTypeValue,
  verdictSource: ConflictVerdictSource
): PathSeedProfile {
  if (verdictSource === "rule") {
    return edgeType === MemoryGraphEdgeType.INCOMPATIBLE_WITH
      ? RULE_INCOMPATIBLE_SEED_PROFILE
      : RULE_CONTRADICTS_SEED_PROFILE;
  }
  return edgeType === MemoryGraphEdgeType.INCOMPATIBLE_WITH
    ? INCOMPATIBLE_SEED_PROFILE
    : CONTRADICTS_SEED_PROFILE;
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
