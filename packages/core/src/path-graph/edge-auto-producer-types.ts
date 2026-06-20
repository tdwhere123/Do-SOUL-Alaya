import { clamp01 } from "../shared/clamp.js";
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
// see also: apps/core-daemon/src/mcp-memory/tool-handler.ts EDGE_CLASSIFY surface.
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

export interface EdgeAutoDecision {
  readonly edgeType: MemoryGraphEdgeTypeValue;
  readonly confidence: number;
  readonly reason: string;
  // invariant: trigger_source must be one of the local_* rule-heuristic
  // enum values, or llm_supports for LLM-port verdicts. Routing back
  // through SYSTEM here would collapse KPI K3.2 per-trigger breakdown.
  readonly triggerSource: EdgeProposalTriggerSourceValue;
}

export interface SimilarityFeatures {
  readonly tokenJaccard: number;
  readonly tagOverlap: number;
  readonly strongTagOverlap: boolean;
}
