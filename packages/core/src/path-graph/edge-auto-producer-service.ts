import {
  EdgeProposalTriggerSource,
  MemoryGraphEdgeType,
  getPathAnchorBackingObjectId,
  type EdgeClassifyVerdict,
  type EdgeProposalTriggerSourceValue,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type {
  EdgeAutoProducerLlmDecision,
  EdgeAutoProducerLlmPort
} from "./edge-auto-producer-llm-port.js";
import {
  DERIVES_FROM_SEED_PROFILE,
  SUPPORTS_SEED_PROFILE,
  type PathSeedProfile
} from "./path-relation-proposal-service.js";
import type { PathCandidateSink } from "./path-candidate-sink.js";
import { CoreError } from "../shared/errors.js";
import { parseObjectId } from "../shared/validators.js";

const NEIGHBOR_SEARCH_LIMIT = 12;
const MAX_EDGE_PROPOSALS_PER_MEMORY = 5;
const SUPPORTS_TOKEN_JACCARD_MIN = 0.45;
const DERIVES_TOKEN_JACCARD_MIN = 0.28;
const SUPERSEDES_TOKEN_JACCARD_MIN = 0.5;
// invariant: the local contradicts heuristic shares the supersedes token-Jaccard
// floor (0.5) — a contradicts pair must be about the same subject (high lexical
// overlap) for a negation cue between them to mean disagreement rather than two
// unrelated statements. Strong-overlap + a CONTRADICTION cue is the conservative
// signal; below this floor the pair is left to the SUPPORTS/DERIVES_FROM lanes
// or to no edge. see also: isContradictsCandidate, CONTRADICTION_CUES.
const CONTRADICTS_TOKEN_JACCARD_MIN = 0.5;
const STRONG_TAG_OVERLAP_MIN = 0.5;
// invariant: LLM pair-classifier verdicts MUST clear this confidence
// floor to enter the proposal queue. A below-floor verdict is dropped
// (the service then falls back to the local heuristic for that
// neighbor) so a noisy garden response cannot inject low-quality
// supports/derives_from proposals into the queue.
const LLM_CONFIDENCE_FLOOR = 0.85;
// invariant: LLM-pregate floor. A pair below this token-Jaccard +
// tag-overlap threshold cannot meaningfully clear DERIVES_TOKEN_JACCARD_MIN
// (0.28) for the local heuristic either, so we skip the garden round-trip
// and fall straight back to the (likely-null) local classifier. The
// threshold is intentionally below the heuristic's DERIVES floor (the
// loosest of the three classifier paths) so the LLM still gets to see
// the "borderline" pair-space where its judgement matters most. A pair
// with zero token overlap AND zero tag overlap is the obvious-non-pair
// the pregate is meant to drop.
const LLM_PREGATE_TOKEN_JACCARD_MIN = 0.2;

const DERIVATION_CUES = [
  "based on",
  "because",
  "therefore",
  "derived from",
  "as a result",
  "follows from",
  "inferred from",
  "基于",
  "因此",
  "所以",
  "由此"
];

const REPLACEMENT_CUES = [
  "instead of",
  "replaces",
  "replace",
  "supersedes",
  "no longer",
  "deprecated",
  "rather than",
  "must not",
  "should not",
  "do not",
  "don't",
  "替代",
  "取代",
  "不再",
  "废弃",
  "改为",
  "改成",
  "不要",
  "禁止"
];

// invariant: conservative contradiction cues. These mark a new memory that
// explicitly DISAGREES WITH / NEGATES a prior claim, distinct from REPLACEMENT_CUES
// (which mark a newer-version-replaces-older supersession). The two cue sets are
// intentionally disjoint: a "no longer / replace" statement is supersedes (the
// new fact is the live one), while a "contradicts / not true / actually the
// opposite" statement is contradicts (the two facts disagree without one
// retiring the other). Bilingual (en + zh). A bare negation word like "not" is
// deliberately absent — it is too noisy; only explicit disagreement phrases
// qualify so the rule never fabricates a contradiction from incidental negation.
// see also: isContradictsCandidate, REPLACEMENT_CUES.
const CONTRADICTION_CUES = [
  "contradicts",
  "contradict",
  "is not true",
  "is false",
  "is incorrect",
  "is wrong",
  "actually the opposite",
  "on the contrary",
  "disagree with",
  "not the case",
  "矛盾",
  "相反",
  "并非",
  "不是真的",
  "是错的",
  "是错误的",
  "不对",
  "恰恰相反"
];

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "use",
  "uses",
  "with"
]);

export interface EdgeAutoProducerMemorySearchHit {
  readonly object_id: string;
  readonly normalized_rank?: number;
}

export interface EdgeAutoProducerMemoryRepoPort {
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
  searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly EdgeAutoProducerMemorySearchHit[]>;
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]>;
}

// invariant: the host-worker defer port. When present, the LLM-quality pair
// verdict for an eligible neighbor is ENQUEUED as an EDGE_CLASSIFY garden task
// for an attached CLI agent (the compute) to render, instead of a synchronous
// in-process cloud call. The deterministic heuristic still runs inline, but it
// only emits an edge for a STRONG-overlap pair (tag overlap >= STRONG_TAG_OVERLAP_MIN).
// A weak-overlap pair (passes the LLM pregate but below strongTagOverlap) gets
// NO inline edge — it is edge-on-verdict: the host verdict is the only edge it
// can ever earn. So for strong-overlap pairs an edge exists at enrichment time
// regardless of whether a worker ever claims; for weak-overlap pairs the edge
// is eventual (verdict-only). enqueueEdgeClassify is best-effort: a failure to
// enqueue must not abort proposal production (any heuristic verdict already
// stands), so the service swallows enqueue errors through the warn callback.
// see also: apps/core-daemon/src/mcp-memory-tool-handler.ts EDGE_CLASSIFY surface.
export interface EdgeClassifyQueuePort {
  enqueueEdgeClassify(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly sourceSignalId: string;
    readonly dimension: string;
    readonly scopeClass: string;
    readonly source: { readonly object_id: string; readonly content: string; readonly domainTags: readonly string[] };
    readonly neighbor: { readonly object_id: string; readonly content: string; readonly domainTags: readonly string[] };
  }): Promise<void>;
}

// invariant: applyVerdict-local read port for directional-dedup. A host
// EDGE_CLASSIFY verdict and the inline heuristic on the SAME ordered pair are
// ONE positive-associative slot: the verdict refines the heuristic edge, it
// never mints a SECOND parallel positive path. The shared
// pathRelationMatchesIdentity treats supports vs derives_from as DIFFERENT
// identity families (positive:supports != positive:derives_from), so a
// family-swap verdict would otherwise slip past the sink's durable dedup and
// double the pair's recall-bias from untrusted worker input. This port lets
// applyVerdict ask "does any positive associative path already exist for this
// exact ordered pair?" so the verdict becomes a no-op refinement instead.
// Optional: when unwired (e.g. unit fakes) applyVerdict falls back to the
// sink's same-family dedup only — the family-swap guard is daemon-wired.
// see also: packages/protocol/src/soul/path-relation.ts pathRelationIdentityFamily.
export interface EdgeClassifyExistingPathReaderPort {
  findByBackingObjectId(
    workspaceId: string,
    objectId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
}

// invariant: edge auto-producer sink is the governed path candidate
// intake (PathCandidateSink), not memory_graph_edges. A supports/
// derives_from candidate is born a weak attention_only path (recall_bias
// +) that earns recall eligibility only through PathPlasticityService
// reinforcement; it is never auto-accepted into a permanent edge.
// see also: path-candidate-sink.ts PathCandidateSink — the shared port.
export interface EdgeAutoProducerServiceDependencies {
  readonly memoryRepo: EdgeAutoProducerMemoryRepoPort;
  readonly pathCandidatePort: PathCandidateSink;
  /**
   * Optional in-process pair classifier port. When present AND no
   * edgeClassifyQueue is wired, the service asks the port for a
   * supports / derives_from verdict before running the local heuristic;
   * a verdict >= LLM_CONFIDENCE_FLOOR is emitted with trigger_source =
   * "llm_supports". A null / failing / below-floor verdict triggers the
   * local-heuristic fallback for that neighbor. Adapter failures are
   * observable via the optional warn callback; they never abort proposal
   * production for the new memory.
   *
   * invariant: when edgeClassifyQueue is wired the synchronous llmPort
   * is NOT consulted — the LLM-quality verdict is deferred to the
   * host-worker EDGE_CLASSIFY task instead. The product form is MCP/CLI:
   * the attached agent is the compute, not an in-process cloud call.
   */
  readonly llmPort?: EdgeAutoProducerLlmPort;
  /**
   * Optional host-worker defer port. When present, the
   * LLM-quality verdict step is enqueued as an EDGE_CLASSIFY garden task
   * (best-effort / eventual) for the attached CLI agent to render, and
   * the synchronous llmPort is bypassed. The deterministic heuristic
   * still runs inline and submits its path immediately for STRONG-overlap
   * pairs, so recall right after memory creation uses that heuristic edge
   * until the host worker completes the task. A weak-overlap pair (below
   * strongTagOverlap) has no inline edge — its edge is eventual,
   * materializing only when the host verdict arrives. see
   * EdgeClassifyQueuePort.
   */
  readonly edgeClassifyQueue?: EdgeClassifyQueuePort;
  /**
   * Optional read port for applyVerdict directional-dedup. When present, a
   * host EDGE_CLASSIFY verdict on an ordered pair that ALREADY carries a
   * positive associative path (e.g. the inline heuristic minted `supports`)
   * is a no-op refinement rather than a parallel `derives_from` mint, so the
   * pair never gets a doubled recall-bias from untrusted worker input. When
   * unwired, applyVerdict relies on the sink's same-family durable dedup only.
   */
  readonly existingPathReader?: EdgeClassifyExistingPathReaderPort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export interface EdgeAutoProducerInput {
  readonly newMemoryId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly sourceSignalId: string;
}

interface EdgeAutoDecision {
  readonly edgeType: MemoryGraphEdgeTypeValue;
  readonly confidence: number;
  readonly reason: string;
  // invariant: trigger_source must be one of the local_* rule-heuristic
  // enum values, or llm_supports for LLM-port verdicts. Routing back
  // through SYSTEM here would collapse KPI K3.2 per-trigger breakdown.
  readonly triggerSource: EdgeProposalTriggerSourceValue;
}

interface SimilarityFeatures {
  readonly tokenJaccard: number;
  readonly tagOverlap: number;
  readonly strongTagOverlap: boolean;
}

export class EdgeAutoProducerService {
  public constructor(private readonly deps: EdgeAutoProducerServiceDependencies) {}

  public async produceForNewMemory(input: EdgeAutoProducerInput): Promise<void> {
    const newMemoryId = parseObjectId(input.newMemoryId);
    const workspaceId = parseObjectId(input.workspaceId);
    const newMemory = await this.deps.memoryRepo.findById(newMemoryId);
    if (newMemory === null) {
      throw new CoreError("NOT_FOUND", `New memory not found for edge auto-producer: ${newMemoryId}`);
    }
    if (newMemory.workspace_id !== workspaceId) {
      throw new CoreError(
        "VALIDATION",
        `New memory does not belong to workspace ${workspaceId}: ${newMemoryId}`
      );
    }

    const neighborIds = await this.collectNeighborIds(workspaceId, newMemory);
    if (neighborIds.length === 0) {
      return;
    }
    const neighbors = await this.deps.memoryRepo.findByIds(neighborIds);
    const rankById = new Map(neighborIds.map((objectId, index) => [objectId, index]));
    const orderedNeighbors = [...neighbors].sort(
      (left, right) =>
        (rankById.get(left.object_id) ?? Number.MAX_SAFE_INTEGER) -
        (rankById.get(right.object_id) ?? Number.MAX_SAFE_INTEGER)
    );

    let proposalCount = 0;
    // invariant: a transient submitCandidate failure ("failed") on ANY
    // candidate must not be swallowed — the bulk-enrich worker treats this
    // method resolving as success and would markProcessed the owed path away.
    // We collect transient failures and throw after the loop so the worker's
    // per-memory catch releases the claim for stale-claim retry. A permanent
    // "rejected" (bad anchor) is NOT a transient failure: retrying cannot help,
    // so it does not block markProcessed. applied / already_present settle.
    let transientFailures = 0;
    for (const neighbor of orderedNeighbors) {
      if (proposalCount >= MAX_EDGE_PROPOSALS_PER_MEMORY) {
        break;
      }
      const decision = await this.decideForNeighbor(newMemory, neighbor, input);
      if (decision === null) {
        continue;
      }
      const profile = seedProfileForEdgeType(decision.edgeType);
      const outcome = await this.deps.pathCandidatePort.submitCandidate({
        workspaceId,
        sourceAnchor: { kind: "object", object_id: newMemory.object_id },
        targetAnchor: { kind: "object", object_id: neighbor.object_id },
        relationKind: profile.relationKind,
        initialStrength: profile.initialStrength,
        governanceClass: profile.governanceClass,
        evidenceBasis: profile.evidenceBasis,
        recallBiasSign: profile.recallBiasSign,
        recallBiasMagnitude: profile.recallBiasMagnitude,
        why: [
          `${decision.triggerSource}: ${decision.reason}`,
          `source_signal=${input.sourceSignalId} run=${input.runId}`
        ],
        runId: input.runId
      });
      if (outcome === "failed") {
        transientFailures += 1;
      }
      // invariant: the per-memory MAX_EDGE_PROPOSALS budget counts only paths
      // that actually landed ("applied"). already_present means an equivalent
      // link already exists (no new topology, so it must not consume budget);
      // a transient "failed" will be retried by a later enrich cycle; a
      // permanent "rejected" minted nothing. Counting non-applied outcomes
      // would let already-linked / failed neighbors starve genuinely-new
      // neighbors past the cap on retry.
      if (outcome === "applied") {
        proposalCount += 1;
      }
    }
    if (transientFailures > 0) {
      throw new CoreError(
        "OBLIGATION_VIOLATION",
        `Edge auto-producer: ${transientFailures} path candidate(s) failed transiently for ${newMemory.object_id}`
      );
    }
  }

  /**
   * Decides the inline verdict for a neighbor and, when the host-worker
   * defer port is wired, enqueues the best-effort LLM-quality verdict.
   *
   * invariant: the deterministic heuristic (classifyNeighbor) ALWAYS
   * runs inline, but it only emits an edge for a STRONG-overlap pair
   * (tag overlap >= STRONG_TAG_OVERLAP_MIN). A weak-overlap pair (passes
   * the LLM pregate but below strongTagOverlap) gets NO inline edge — for
   * such a pair the edge is eventual, earned only when a host verdict
   * arrives. The LLM-quality step is one of:
   *   - DEFERRED: when edgeClassifyQueue is wired, an EDGE_CLASSIFY task
   *     is enqueued (best-effort) for the attached CLI agent to render;
   *     the inline heuristic verdict (possibly null for weak overlap) is
   *     what is returned and submitted now. A later host verdict refines
   *     a strong-overlap edge, or first creates a weak-overlap edge, via
   *     applyVerdict.
   *   - SYNCHRONOUS: when only llmPort is wired (no edgeClassifyQueue),
   *     the LLM runs in-process first and its >= floor verdict wins;
   *     null / below-floor falls back to the heuristic.
   * The eligibility prefilter (same workspace, dimension, scope,
   * lifecycle=active) is shared so the LLM/host worker only ever sees
   * eligible pairs. A content-similarity pregate (token-Jaccard +
   * tag-overlap) gates the LLM/defer step so a fan-out of 12
   * structurally-eligible-but-unrelated neighbors does not fire 12
   * garden round-trips per new memory.
   * see also: passesLlmPregate, LLM_PREGATE_TOKEN_JACCARD_MIN, applyVerdict.
   */
  private async decideForNeighbor(
    newMemory: Readonly<MemoryEntry>,
    neighbor: Readonly<MemoryEntry>,
    input: EdgeAutoProducerInput
  ): Promise<EdgeAutoDecision | null> {
    if (!isEligibleNeighbor(newMemory, neighbor)) {
      return null;
    }
    if (this.deps.edgeClassifyQueue !== undefined) {
      if (passesLlmPregate(newMemory, neighbor)) {
        await this.deferEdgeClassify(newMemory, neighbor, input);
      }
      return classifyNeighbor(newMemory, neighbor);
    }
    if (this.deps.llmPort !== undefined && passesLlmPregate(newMemory, neighbor)) {
      const llmDecision = await this.tryLlmDecision(newMemory, neighbor);
      if (llmDecision !== null) {
        return llmDecision;
      }
    }
    return classifyNeighbor(newMemory, neighbor);
  }

  /**
   * Enqueues the best-effort EDGE_CLASSIFY garden task for an eligible
   * pregate-passing pair. Failure to enqueue is non-fatal: the inline
   * heuristic verdict already stands, so a queue hiccup only loses the
   * LLM-quality refinement, never the edge. A single observable warn is
   * emitted for the operator.
   */
  private async deferEdgeClassify(
    newMemory: Readonly<MemoryEntry>,
    neighbor: Readonly<MemoryEntry>,
    input: EdgeAutoProducerInput
  ): Promise<void> {
    const queue = this.deps.edgeClassifyQueue;
    if (queue === undefined) {
      return;
    }
    try {
      await queue.enqueueEdgeClassify({
        workspaceId: input.workspaceId,
        runId: input.runId,
        sourceSignalId: input.sourceSignalId,
        dimension: newMemory.dimension,
        scopeClass: newMemory.scope_class,
        source: {
          object_id: newMemory.object_id,
          content: newMemory.content,
          domainTags: newMemory.domain_tags
        },
        neighbor: {
          object_id: neighbor.object_id,
          content: neighbor.content,
          domainTags: neighbor.domain_tags
        }
      });
    } catch (err) {
      this.warn("edge auto producer edge-classify enqueue failed", {
        new_memory_id: newMemory.object_id,
        neighbor_memory_id: neighbor.object_id,
        error: errorMessage(err)
      });
    }
  }

  /**
   * Applies a host-worker EDGE_CLASSIFY verdict to the existing path.
   * Called by the daemon when an attached agent completes an
   * EDGE_CLASSIFY task. The verdict refines the heuristic edge by
   * submitting the LLM-quality relation through the SAME governed
   * PathCandidateSink the inline heuristic used:
   *   - matches the heuristic relation -> already_present (no-op, the
   *     heuristic verdict stands);
   *   - a DIFFERENT positive family on the SAME ordered pair (e.g. the
   *     heuristic minted supports, the verdict says derives_from) is ONE
   *     positive-associative slot: the verdict is a no-op refinement (the
   *     heuristic edge stands), NOT a second parallel positive path. This is
   *     enforced via existingPathReader because the shared
   *     pathRelationMatchesIdentity treats supports vs derives_from as
   *     distinct identity families, so the sink alone would let the
   *     family-swap double the pair's recall-bias. When existingPathReader is
   *     unwired the verdict still submits and relies on same-family sink dedup.
   * invariant: a "none" or below-LLM_CONFIDENCE_FLOOR verdict refines
   * nothing — the inline heuristic edge is never destroyed by a host
   * verdict (agents propose, Alaya decides; the verdict only ever adds a
   * weak governed candidate, never removes durable topology). Returns the
   * PathMintOutcome string when a relation was submitted, "already_present"
   * when the directional-dedup short-circuited a family-swap mint, or null
   * when the verdict was a no-op (none / below floor).
   */
  public async applyVerdict(input: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
    readonly verdict: EdgeClassifyVerdict;
  }): Promise<string | null> {
    const workspaceId = parseObjectId(input.workspaceId);
    const sourceId = parseObjectId(input.verdict.source_object_id);
    const targetId = parseObjectId(input.verdict.neighbor_object_id);
    if (input.verdict.edge_type === "none") {
      return null;
    }
    if (clamp01(input.verdict.confidence) < LLM_CONFIDENCE_FLOOR) {
      return null;
    }
    // Directional-dedup: a host verdict on an ordered pair that already carries
    // a positive associative path is ONE slot with the inline heuristic edge.
    // A family-swap (heuristic supports -> verdict derives_from) must NOT mint a
    // second parallel positive path. The verdict only ever refines in-place
    // within the same family (which the sink already settles as already_present);
    // a different positive family is a no-op refinement here.
    if (await this.positiveAssociativePathExists(workspaceId, sourceId, targetId)) {
      return "already_present";
    }
    const edgeType =
      input.verdict.edge_type === "supports"
        ? MemoryGraphEdgeType.SUPPORTS
        : MemoryGraphEdgeType.DERIVES_FROM;
    const profile = seedProfileForEdgeType(edgeType);
    const rationale = input.verdict.rationale.trim();
    const why = [
      // invariant: trigger_source = llm_supports for the host-worker pair
      // verdict (both supports and derives_from), matching the in-process
      // llmPort path so K3.2 keeps a single LLM bucket.
      `${EdgeProposalTriggerSource.LLM_SUPPORTS}: B-2 host-worker pair classifier: ${input.verdict.edge_type}${
        rationale.length === 0 ? "" : ` (${rationale})`
      }`,
      `source_signal=${input.sourceSignalId ?? sourceId} run=${input.runId ?? "unattributed"}`
    ];
    const outcome = await this.deps.pathCandidatePort.submitCandidate({
      workspaceId,
      sourceAnchor: { kind: "object", object_id: sourceId },
      targetAnchor: { kind: "object", object_id: targetId },
      relationKind: profile.relationKind,
      initialStrength: profile.initialStrength,
      governanceClass: profile.governanceClass,
      evidenceBasis: profile.evidenceBasis,
      recallBiasSign: profile.recallBiasSign,
      recallBiasMagnitude: profile.recallBiasMagnitude,
      why,
      runId: input.runId
    });
    if (outcome === "failed") {
      // A transient mint failure on the host verdict loses the LLM-quality
      // refinement; the inline heuristic edge still stands so this is not
      // fatal, but it must be observable rather than silently swallowed.
      this.warn("edge auto producer host verdict mint failed transiently", {
        source_object_id: sourceId,
        neighbor_object_id: targetId,
        edge_type: input.verdict.edge_type
      });
    }
    return outcome;
  }

  /**
   * Returns true when a positive associative (recall_bias > 0) path already
   * exists for the exact ordered pair sourceId -> targetId. Used by
   * applyVerdict to collapse a heuristic+verdict family-swap into one slot.
   * Returns false when no reader is wired (the sink's same-family dedup is the
   * only guard then). A reader failure is non-fatal: it falls back to letting
   * the verdict submit (the sink still settles same-family duplicates).
   */
  private async positiveAssociativePathExists(
    workspaceId: string,
    sourceId: string,
    targetId: string
  ): Promise<boolean> {
    const reader = this.deps.existingPathReader;
    if (reader === undefined) {
      return false;
    }
    let existing: readonly Readonly<PathRelation>[];
    try {
      existing = await reader.findByBackingObjectId(workspaceId, sourceId);
    } catch (err) {
      this.warn("edge auto producer existing-path lookup failed", {
        source_object_id: sourceId,
        neighbor_object_id: targetId,
        error: errorMessage(err)
      });
      return false;
    }
    return existing.some((relation) => {
      if (relation.effect_vector.recall_bias <= 0) {
        return false;
      }
      if (relation.lifecycle.status !== "active") {
        return false;
      }
      const relationSource = getPathAnchorBackingObjectId(relation.anchors.source_anchor);
      const relationTarget = getPathAnchorBackingObjectId(relation.anchors.target_anchor);
      return relationSource === sourceId && relationTarget === targetId;
    });
  }

  private async tryLlmDecision(
    newMemory: Readonly<MemoryEntry>,
    neighbor: Readonly<MemoryEntry>
  ): Promise<EdgeAutoDecision | null> {
    const port = this.deps.llmPort;
    if (port === undefined) {
      return null;
    }
    let verdict: EdgeAutoProducerLlmDecision | null;
    try {
      verdict = await port.classifyPair({ newMemory, neighbor });
    } catch (err) {
      // Adapter failure must not block proposal production for the new
      // memory; the local heuristic still runs for this neighbor and the
      // operator gets a single observable event.
      this.warn("edge auto producer llm port classify failed", {
        new_memory_id: newMemory.object_id,
        neighbor_memory_id: neighbor.object_id,
        error: errorMessage(err)
      });
      return null;
    }
    if (verdict === null) {
      return null;
    }
    const clampedConfidence = clamp01(verdict.confidence);
    if (clampedConfidence < LLM_CONFIDENCE_FLOOR) {
      return null;
    }
    const edgeType =
      verdict.edgeType === "supports"
        ? MemoryGraphEdgeType.SUPPORTS
        : MemoryGraphEdgeType.DERIVES_FROM;
    const rationale = verdict.rationale.trim();
    return {
      edgeType,
      confidence: round2(clampedConfidence),
      // invariant: trigger_source = llm_supports for BOTH supports and
      // derives_from when sourced from the LLM port. Reuses a single
      // per-trigger KPI bucket for the pair classifier so K3.2 does not
      // need two LLM rows.
      triggerSource: EdgeProposalTriggerSource.LLM_SUPPORTS,
      reason: rationale.length === 0
        ? `B-2 llm pair classifier: ${verdict.edgeType}`
        : `B-2 llm pair classifier: ${verdict.edgeType} (${rationale})`
    };
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    if (this.deps.warn !== undefined) {
      this.deps.warn(message, meta);
    }
  }

  private async collectNeighborIds(
    workspaceId: string,
    newMemory: Readonly<MemoryEntry>
  ): Promise<readonly string[]> {
    const hits = await this.deps.memoryRepo.searchByKeyword(
      workspaceId,
      newMemory.content,
      NEIGHBOR_SEARCH_LIMIT
    );
    const ids: string[] = [];
    const seen = new Set<string>([newMemory.object_id]);
    for (const hit of hits) {
      if (seen.has(hit.object_id)) {
        continue;
      }
      seen.add(hit.object_id);
      ids.push(hit.object_id);
      if (ids.length >= NEIGHBOR_SEARCH_LIMIT) {
        break;
      }
    }
    return ids;
  }
}

// invariant: a local heuristic / LLM supersedes verdict is a weak claim,
// not a system-derived conflict ruling. It seeds attention_only at a low
// strength (recall_bias - kept so plasticity classifies it as a negative
// lifecycle path) and must earn recall eligibility through
// PathPlasticityService reinforcement — it never mints a recall_allowed
// negative path. This deliberately diverges from the shared
// SUPERSEDES_SEED_PROFILE (recall_allowed/0.9), which is reserved for
// SYSTEM-derived negatives produced by ConflictDetectionService.
// see also: packages/core/src/governance/conflict-detection-service.ts — SYSTEM negatives.
const LOCAL_SUPERSEDES_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "supersedes",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["supersession_evidence"]) as readonly string[]
});

// invariant: the local contradicts heuristic is the negative-cue sibling of
// LOCAL_SUPERSEDES_SEED_PROFILE. It is a weak local claim (a deterministic
// negation/contradiction cue between a new memory and a strong-overlap
// neighbor), NOT a SYSTEM-derived conflict ruling, so it seeds attention_only
// at recall_bias -0.4 and earns recall eligibility only through plasticity
// reinforcement — it never mints the recall_allowed/0.9 CONTRADICTS_SEED_PROFILE
// reserved for ConflictDetectionService's LLM/Jaccard verdict. Magnitude 0.4
// mirrors the contradicts entry in the SIGNAL_REF_SEED_SPECS / shared catalog so
// a local-cue contradicts and an agent-asserted contradicts_ref carry the same
// negative weight.
// see also: packages/core/src/governance/conflict-detection-service.ts — SYSTEM negatives;
//   packages/soul/src/garden/materialization-router/signal-ref-seeds.ts SIGNAL_REF_SEED_SPECS.
const LOCAL_CONTRADICTS_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "contradicts",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.4,
  evidenceBasis: Object.freeze(["contradiction_evidence"]) as readonly string[]
});

// invariant: maps the producer's edge-type verdict to the path seed
// profile that carries its initial strength / governance / recall_bias
// sign. supports + derives_from are positive associative profiles; the
// local supersedes heuristic is a weak negative lifecycle profile
// (recall_bias -, attention_only). The producer never mints exception_to.
function seedProfileForEdgeType(edgeType: MemoryGraphEdgeTypeValue): PathSeedProfile {
  switch (edgeType) {
    case MemoryGraphEdgeType.DERIVES_FROM:
      return DERIVES_FROM_SEED_PROFILE;
    case MemoryGraphEdgeType.SUPERSEDES:
      return LOCAL_SUPERSEDES_SEED_PROFILE;
    case MemoryGraphEdgeType.CONTRADICTS:
      return LOCAL_CONTRADICTS_SEED_PROFILE;
    case MemoryGraphEdgeType.SUPPORTS:
    default:
      return SUPPORTS_SEED_PROFILE;
  }
}

function classifyNeighbor(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>
): EdgeAutoDecision | null {
  if (!isEligibleNeighbor(newMemory, neighbor)) {
    return null;
  }
  const features = computeSimilarity(newMemory, neighbor);
  if (!features.strongTagOverlap) {
    return null;
  }
  if (isSupersedesCandidate(newMemory, neighbor, features)) {
    return {
      edgeType: MemoryGraphEdgeType.SUPERSEDES,
      confidence: confidence(0.55, features, 0.05, 0.85),
      reason: describeDecision("B-3 local supersedes heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_SUPERSEDES
    };
  }
  // invariant: contradicts is checked AFTER supersedes — a replacement cue is a
  // stronger retirement signal and wins when both fire. Its own LOCAL_CONTRADICTS
  // trigger_source keeps the K3.2 per-trigger KPI bucket distinct from the
  // supersedes lane.
  if (isContradictsCandidate(newMemory, features)) {
    return {
      edgeType: MemoryGraphEdgeType.CONTRADICTS,
      confidence: confidence(0.55, features, 0, 0.8),
      reason: describeDecision("B-3 local contradicts heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_CONTRADICTS
    };
  }
  if (isDerivesFromCandidate(newMemory, features)) {
    return {
      edgeType: MemoryGraphEdgeType.DERIVES_FROM,
      confidence: confidence(0.55, features, 0, 0.8),
      reason: describeDecision("B-2 local derives_from heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_DERIVES_FROM
    };
  }
  if (features.tokenJaccard >= SUPPORTS_TOKEN_JACCARD_MIN) {
    return {
      edgeType: MemoryGraphEdgeType.SUPPORTS,
      confidence: confidence(0.55, features, 0, 0.8),
      reason: describeDecision("B-2 local supports heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_SUPPORTS
    };
  }
  return null;
}

/**
 * LLM cost pregate. A pair must clear EITHER a small token-Jaccard
 * floor OR a non-empty tag-overlap signal before the LLM port is
 * consulted. The intent is to drop the "structurally eligible but
 * obviously unrelated" pairs (same workspace + dimension + scope but
 * zero shared lexical content) that would otherwise fan out to
 * NEIGHBOR_SEARCH_LIMIT garden calls per new memory under a full bench.
 *
 * The token-Jaccard floor (0.2) is intentionally below the local
 * heuristic's DERIVES_TOKEN_JACCARD_MIN (0.28) so the LLM still gets
 * the borderline pair-space where its judgement is most valuable;
 * pairs the heuristic could already classify deterministically are not
 * locked out, they just route through the LLM first as today.
 */
function passesLlmPregate(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>
): boolean {
  const features = computeSimilarity(newMemory, neighbor);
  return features.tokenJaccard >= LLM_PREGATE_TOKEN_JACCARD_MIN || features.tagOverlap > 0;
}

function isEligibleNeighbor(newMemory: Readonly<MemoryEntry>, neighbor: Readonly<MemoryEntry>): boolean {
  return (
    neighbor.object_id !== newMemory.object_id &&
    neighbor.lifecycle_state === "active" &&
    neighbor.workspace_id === newMemory.workspace_id &&
    neighbor.dimension === newMemory.dimension &&
    neighbor.scope_class === newMemory.scope_class
  );
}

function isSupersedesCandidate(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>,
  features: SimilarityFeatures
): boolean {
  return (
    newMemory.created_at > neighbor.created_at &&
    features.tokenJaccard >= SUPERSEDES_TOKEN_JACCARD_MIN &&
    hasAnyCue(newMemory.content, REPLACEMENT_CUES)
  );
}

// invariant: conservative local contradicts detection. Requires high lexical
// overlap (same subject) AND an explicit CONTRADICTION cue in the new memory.
// No created_at ordering gate (unlike supersedes): a contradiction is symmetric
// disagreement, not a newer-version replacement. The strongTagOverlap gate from
// classifyNeighbor still applies upstream, so the pair is already same-subject;
// this adds the lexical-overlap floor + the explicit-cue requirement so an
// incidental negation never fabricates a contradicts edge.
function isContradictsCandidate(
  newMemory: Readonly<MemoryEntry>,
  features: SimilarityFeatures
): boolean {
  return (
    features.tokenJaccard >= CONTRADICTS_TOKEN_JACCARD_MIN &&
    hasAnyCue(newMemory.content, CONTRADICTION_CUES)
  );
}

function isDerivesFromCandidate(
  newMemory: Readonly<MemoryEntry>,
  features: SimilarityFeatures
): boolean {
  return (
    features.tokenJaccard >= DERIVES_TOKEN_JACCARD_MIN &&
    (newMemory.formation_kind === "derived" || hasAnyCue(newMemory.content, DERIVATION_CUES))
  );
}

function computeSimilarity(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>
): SimilarityFeatures {
  const tokenJaccard = jaccard(tokenize(newMemory.content), tokenize(neighbor.content));
  const tagOverlap = overlapRatio(normalizeLabels(newMemory.domain_tags), normalizeLabels(neighbor.domain_tags));
  return {
    tokenJaccard,
    tagOverlap,
    strongTagOverlap: tagOverlap >= STRONG_TAG_OVERLAP_MIN
  };
}

function tokenize(content: string): readonly string[] {
  return Array.from(
    new Set(
      content
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.filter((token) => token.length > 1 && !STOPWORDS.has(token)) ?? []
    )
  );
}

function normalizeLabels(labels: readonly string[]): readonly string[] {
  return Array.from(new Set(labels.map((label) => label.normalize("NFKC").toLowerCase().trim()).filter(Boolean)));
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  const intersection = left.filter((token) => rightSet.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function overlapRatio(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  const intersection = left.filter((tag) => rightSet.has(tag)).length;
  return intersection / Math.min(left.length, right.length);
}

function hasAnyCue(content: string, cues: readonly string[]): boolean {
  const normalized = content.normalize("NFKC").toLowerCase();
  return cues.some((cue) => normalized.includes(cue));
}

function confidence(
  base: number,
  features: SimilarityFeatures,
  bonus: number,
  max: number
): number {
  const value = base + features.tokenJaccard * 0.2 + features.tagOverlap * 0.1 + bonus;
  return round2(Math.min(max, Math.max(0.55, value)));
}

function describeDecision(label: string, features: SimilarityFeatures): string {
  return `${label}: token_jaccard=${round2(features.tokenJaccard)}, tag_overlap=${round2(features.tagOverlap)}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
