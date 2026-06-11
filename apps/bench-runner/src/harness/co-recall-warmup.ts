// invariant: faithful bench approximation of production's EARNED, SPARSE
// co-recall topology.
// anti-patterns-lint-allow: the production-vs-bench contrast below is the
// load-bearing rationale for a bench-only trigger, not stage history.
//
// Production grows recalls-tier PathRelations from B-1 cross-link: when an
// attached CLI agent reports report_context_usage over memories it co-used,
// PathRelationProposalService.onCoUsage accrues a DURABLE counter for each
// unordered pair, and a co_recalled-family PathRelation is minted ONLY once a
// pair reaches co_usage_threshold (=3) co-occurrences (then the counter row is
// deleted). The topology is therefore EARNED (a pair must recur) and SPARSE (a
// real agent co-uses only a few pairs repeatedly, not whole sessions). The
// bench has NO attached agent reporting usage, so absent a trigger it grows
// ZERO recalls-tier edges, leaving the graph/path plane a dead substrate.
//
// This module computes the bench's stand-in trigger: a small, GOLD-BLIND set of
// co-used member pairs to replay through the PRODUCTION onCoUsage counter gate.
// The bench's ONLY special move is the trigger (a fixed warm-up replay of a few
// session pairs, instead of live report_context_usage across many turns); the
// counter gate, threshold, relation kind, seed profile, and materialize path
// downstream are the production ones. Because minting is gated by the same
// co_usage_threshold, a warm-up that replays each chosen pair exactly threshold
// times mints exactly those pairs and nothing else — earned, and bounded far
// below a saturated hub/clique.
//
// see also: apps/core-daemon/src/mcp-memory-tool-handler.ts crossLinkRecalledMemories
//   + onCoUsage (the live report_context_usage trigger this stands in for)
// see also: packages/core/src/path-graph/path-relation-proposal-service.ts onCoUsage /
//   accrueCoOccurrence / proposeCoRecalled / CO_RECALLED_SEED_PROFILE
// see also: apps/bench-runner/src/harness/daemon.ts accrueSessionCoRecall (sink call)
//
// invariant (earned topology + graph-channel asymmetry, for downstream recall
// design): earned accrual produces a SPARSE CHAIN of unordered PAIRS, not a
// strict hub. planSessionCoRecallWarmup selects adjacent member pairs in seed
// order, and proposeCoRecalled mints each as proposeCoRecalled(low, high) where
// the pair is sorted low<high — so the lexicographically SMALLER member id is
// always the source anchor and the LARGER is the target anchor. Two recall
// channels read this topology differently:
//   - graph_support (recall-service graph_support factor) credits ONLY inbound
//     paths (graph-explore-service.findInboundRecallEligiblePaths ->
//     pathRepo.findByTargetAnchor): of an earned pair only the LARGER-id member
//     (the target) receives graph_support amplification. This is a
//     representative-only-INBOUND asymmetry: a query that surfaces the smaller-id
//     source gets NO graph_support credit toward its sibling.
//   - graph_expansion (recall-service collectPathGraphNeighbors) traverses the
//     edge BIDIRECTIONALLY (co_recalled is minted with
//     direction_bias=bidirectional_asymmetric), so it fans from EITHER member
//     into the other regardless of which id is larger.
// Downstream cohort/fan-in design (R2) must therefore rely on graph_expansion,
// NOT graph_support, for sibling fan-in: graph_support reaches only the target
// member, while graph_expansion reaches both. Mis-designing R2 on graph_support
// would silently miss every source-side sibling.
// see also: packages/core/src/recall/path-relations.ts collectPathGraphNeighbors
// see also: packages/core/src/path-graph/graph-explore-service.ts findInboundRecallEligiblePaths

// anti-patterns-lint-allow: cap rationale, not a consumer-less constant.
// invariant: the warm-up replays at most this many gold-blind adjacent member
// pairs per session, each `threshold` times, so the EARNED co_recalled edge
// count per session is bounded by this cap (much smaller than a same-session
// hub's N-1 spokes or a clique's C(N,2)). A faithful agent co-uses only a few
// pairs repeatedly, not every session member, so a small cap is the realistic
// co-usage footprint.
export const BENCH_CO_RECALL_WARMUP_PAIR_CAP = 3;

export interface CoUsagePair {
  readonly lowMemoryId: string;
  readonly highMemoryId: string;
}

export interface CoRecallWarmupPlan {
  /**
   * Co-used member pairs to replay through onCoUsage. Each pair is one
   * UNORDERED co-usage observation; the harness replays the whole set
   * `replayCount` times so every pair reaches the production co_usage_threshold
   * and earns exactly one co_recalled PathRelation.
   */
  readonly pairs: readonly CoUsagePair[];
  /**
   * How many times to replay the pair set so each pair clears the production
   * co_usage_threshold. The harness passes the daemon's effective threshold;
   * the planner echoes it so the call site stays single-sourced.
   */
  readonly replayCount: number;
}

/**
 * Plan the same-session EARNED co-recall warm-up for one session's member
 * memory ids.
 *
 * invariant: SPARSE chain of adjacent pairs, not a hub or a clique. Production
 * earns a co_recalled edge only for a pair that an agent co-used >=
 * co_usage_threshold times; the bench mirrors that by selecting at most
 * BENCH_CO_RECALL_WARMUP_PAIR_CAP adjacent member pairs (in seed order) and
 * replaying each `threshold` times. The EARNED edge count per session is
 * bounded by BENCH_CO_RECALL_WARMUP_PAIR_CAP, and each edge passes the
 * production counter gate rather than being minted on sight.
 *
 * NO gold knowledge. Pairs are taken from members in SEED ORDER (adjacent
 * positions), a session-deterministic selection that never consults gold/answer
 * turns. Clustering uses ONLY session membership (the caller passes one
 * session's members in seed order), so this function cannot game the benchmark
 * with answer knowledge.
 *
 * Each pair's ids are normalized to (low, high) so the unordered counter key
 * matches production accrueCoOccurrence, which sorts the pair before keying.
 *
 * Duplicate member ids are removed preserving first-seen order (a defensive
 * dedup so a doubled seed cannot produce a self-loop pair). Returns null when
 * fewer than 2 distinct members exist (no co-occurrence to earn) or threshold
 * is not a positive integer.
 */
export function planSessionCoRecallWarmup(
  memberMemoryIds: readonly string[],
  threshold: number
): CoRecallWarmupPlan | null {
  if (!Number.isInteger(threshold) || threshold < 1) {
    return null;
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of memberMemoryIds) {
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push(id);
  }
  if (ordered.length < 2) {
    return null;
  }
  const pairs: CoUsagePair[] = [];
  for (
    let i = 0;
    i + 1 < ordered.length && pairs.length < BENCH_CO_RECALL_WARMUP_PAIR_CAP;
    i += 1
  ) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    // Normalize to (low, high) so the unordered counter key matches production
    // accrueCoOccurrence (which sorts the pair before incrementing the counter).
    const [lowMemoryId, highMemoryId] = a < b ? [a, b] : [b, a];
    pairs.push({ lowMemoryId, highMemoryId });
  }
  if (pairs.length === 0) {
    return null;
  }
  return { pairs, replayCount: threshold };
}

// invariant: outcome tally for ONE session's earned co-recall warm-up. Each
// field counts UNORDERED PAIRS (not onCoUsage calls). minted = pairs that
// reached the threshold and now back a durable co_recalled PathRelation;
// belowThreshold = pairs that never reached it (sparse tail). The bench seed
// loop accumulates these so a diagnostic / assertion can prove the earned
// topology is sparse (minted per session « v1's N-1 saturation).
// see also: apps/bench-runner/src/harness/daemon.ts accrueSessionCoRecall
export interface CoRecallWarmupSummary {
  readonly pairsObserved: number;
  readonly minted: number;
  readonly belowThreshold: number;
}
