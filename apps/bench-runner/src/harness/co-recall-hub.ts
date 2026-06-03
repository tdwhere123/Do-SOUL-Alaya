// invariant: faithful bench approximation of production's co-recall topology.
// anti-patterns-lint-allow: the production-vs-bench contrast below is the
// load-bearing rationale for a bench-only trigger, not stage history.
//
// Production grows recalls-tier PathRelations from B-1 cross-link: when an
// attached CLI agent reports report_context_usage over co-used memories, the
// co-usage counter accrues and (at threshold) mints a co_recalled-family
// PathRelation through PathRelationProposalService.submitCandidate. The bench
// has NO attached agent reporting usage, so absent this trigger it grows ZERO
// recalls-tier edges (only adjacent-turn derives_from), leaving the graph/path
// plane a dead substrate (recalls_edge_count=0).
//
// This module computes the bench's stand-in trigger: which same-session member
// memories should be co-recall-linked, in a HUB shape. The bench's ONLY special
// move is the trigger (session co-occurrence at seed time, instead of live
// report_context_usage); the relation kind + sink + seed profile downstream are
// the production ones (CO_RECALLED_SEED_PROFILE via submitCandidate).
//
// see also: apps/core-daemon/src/mcp-memory-tool-handler.ts crossLinkRecalledMemories
//   (the live report_context_usage trigger this stands in for)
// see also: packages/core/src/path-relation-proposal-service.ts CO_RECALLED_SEED_PROFILE
// see also: apps/bench-runner/src/harness/daemon.ts mintSessionCoRecallHub (the sink call)

// invariant: mirror the production cross-link fanout cap. crossLinkRecalledMemories
// caps the live used-memory cross-link at MAX_CROSS_LINK_FANOUT=8 to bound write
// amplification; the bench mirrors the same cap so a long session does not mint an
// unbounded number of co-recall edges.
// cross-file: apps/core-daemon/src/mcp-memory-tool-handler.ts MAX_CROSS_LINK_FANOUT
export const BENCH_CO_RECALL_HUB_FANOUT_CAP = 8;

export interface CoRecallHubEdge {
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
}

export interface CoRecallHubPlan {
  /** The session-deterministic representative (hub) every member links to. */
  readonly representativeMemoryId: string;
  /** member -> representative directed edges (the hub spokes). */
  readonly edges: readonly CoRecallHubEdge[];
}

// invariant: outcome tally for ONE session's hub mint, summed across spokes.
// applied + alreadyPresent are settled successes; rejected is a decided anchor
// refusal; failed is a transient sink error. The bench seed loop accumulates
// these so a diagnostic / assertion can prove NONZERO accepted recalls-tier
// edges (applied + alreadyPresent > 0) were minted.
// see also: apps/bench-runner/src/harness/daemon.ts mintSessionCoRecallHub
export interface CoRecallHubMintSummary {
  readonly applied: number;
  readonly alreadyPresent: number;
  readonly rejected: number;
  readonly failed: number;
}

/**
 * Plan the same-session co-recall HUB for one session's member memory ids.
 *
 * invariant: HUB shape, not clique. Each capped member links to ONE
 * session-deterministic representative (the FIRST seeded member): N-1 edges
 * with bounded 2-hop reach (any two members reach each other through the hub)
 * instead of a clique's N^2 edges. crossLinkRecalledMemories cliques within the
 * same fanout cap; the bench uses the hub because a 500q archive with many long
 * sessions would otherwise mint quadratic edge counts.
 *
 * NO gold knowledge. The representative is the FIRST member in seed order —
 * a session-deterministic position, NEVER the gold/answer turn. Clustering uses
 * ONLY session membership (the caller passes one session's members), so this
 * function cannot game the benchmark with answer knowledge.
 *
 * Fanout cap: members are truncated to BENCH_CO_RECALL_HUB_FANOUT_CAP before
 * linking, mirroring the production MAX_CROSS_LINK_FANOUT. The representative is
 * chosen from the FULL ordered member list (its first element), then the capped
 * remainder link to it; this keeps the hub stable regardless of where the cap
 * falls.
 *
 * Duplicate member ids (a round that seeded the same object twice is not
 * expected, but a defensive dedup keeps the plan from minting a self-loop or a
 * doubled spoke) are removed preserving first-seen order. Returns null when
 * fewer than 2 distinct members exist — a single-member session has no
 * co-occurrence to link.
 */
export function planSessionCoRecallHub(
  memberMemoryIds: readonly string[]
): CoRecallHubPlan | null {
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
  // Session-deterministic hub: the first seeded member. Independent of which
  // member (if any) is gold.
  const representativeMemoryId = ordered[0]!;
  const cappedMembers = ordered.slice(0, BENCH_CO_RECALL_HUB_FANOUT_CAP);
  const edges: CoRecallHubEdge[] = [];
  for (const memberId of cappedMembers) {
    if (memberId === representativeMemoryId) {
      continue;
    }
    edges.push({ sourceMemoryId: memberId, targetMemoryId: representativeMemoryId });
  }
  if (edges.length === 0) {
    return null;
  }
  return { representativeMemoryId, edges };
}
