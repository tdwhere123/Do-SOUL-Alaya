import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  RECALL_FUSION_STREAMS,
  recallDeliveryReserveTestInternals
} from "../../recall/recall-service.js";
import type {
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallSupplementaryData
} from "../../recall/recall-service-types.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
const {
  selectUncoveredSynthesisCapsules,
  reserveSynthesisDeliverySlots,
  reserveStructuralDeliverySlots,
  synthesisReserveCount,
  buildEmptyRecallFusionBreakdown,
  isStructuralRescueCandidate,
  applySessionCoverageRerank
} = recallDeliveryReserveTestInternals;
function memory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "00000000-0000-4000-8000-000000000000",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "memory content",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}
function emptyStreamContributions(): Record<RecallFusionStream, number> {
  return Object.fromEntries(
    RECALL_FUSION_STREAMS.map((stream) => [stream, 0])
  ) as Record<RecallFusionStream, number>;
}
function emptyStreamRanks(): Record<RecallFusionStream, number | null> {
  return Object.fromEntries(
    RECALL_FUSION_STREAMS.map((stream) => [stream, null])
  ) as Record<RecallFusionStream, number | null>;
}
type FusedCandidate = Readonly<{
  readonly entry: Readonly<MemoryEntry>;
  readonly originPlane: "workspace_local";
  readonly objectKind: "memory_entry" | "synthesis_capsule";
  readonly effectiveScore: number;
  // RecallScoreFactors requires relevance + activation; the delivery-reserve
  // helpers never read score_factors, so the minimal valid shape suffices.
  readonly effectiveFactors: { readonly relevance: number; readonly activation: number };
  readonly structuralScore?: number;
  // Internal-only discriminator: true when the candidate was admitted on the
  // path_expansion plane via an EARNED co_recalled fan-in carrier (R1, the
  // sparse durable multi-session fan-in route). isStructuralRescueCandidate
  // reads it as the bounded exemption from the relevance gate. see also:
  // packages/core/src/recall/fusion-delivery.ts:isStructuralRescueCandidate.
  readonly reachedViaEarnedCoRecalledFanin?: boolean;
  readonly fusion: Readonly<RecallFusionBreakdown>;
}>;
function fusedCandidate(input: {
  readonly objectId: string;
  readonly objectKind?: "memory_entry" | "synthesis_capsule";
  readonly evidenceRefs?: readonly string[];
  readonly contributions?: Partial<Record<RecallFusionStream, number>>;
  readonly reachedViaEarnedCoRecalledFanin?: boolean;
}): FusedCandidate {
  const objectKind = input.objectKind ?? "memory_entry";
  const entry = memory({
    object_id: input.objectId,
    evidence_refs: input.evidenceRefs ?? []
  });
  const breakdown = buildEmptyRecallFusionBreakdown(input.objectId);
  const contributions = {
    ...emptyStreamContributions(),
    ...(input.contributions ?? {})
  };
  return Object.freeze({
    entry,
    originPlane: "workspace_local" as const,
    objectKind,
    effectiveScore: 0,
    effectiveFactors: { relevance: 0, activation: 0 },
    ...(input.reachedViaEarnedCoRecalledFanin
      ? { reachedViaEarnedCoRecalledFanin: true }
      : {}),
    fusion: Object.freeze({
      ...breakdown,
      object_kind: objectKind,
      per_stream_rank: Object.freeze(emptyStreamRanks()) as RecallFusionBreakdown["per_stream_rank"],
      fused_rank: 1,
      fused_score: 0,
      fused_rank_contribution_per_stream:
        Object.freeze(contributions) as RecallFusionBreakdown["fused_rank_contribution_per_stream"]
    })
  });
}
function supplementary(
  overrides: Partial<RecallSupplementaryData> = {}
): RecallSupplementaryData {
  return Object.freeze({
    queryProbes: compileRecallQueryProbes(null),
    ftsRanks: Object.freeze({}),
    trigramFtsRanks: Object.freeze({}),
    synthesisFtsRanks: Object.freeze({}),
    evidenceFtsRanks: Object.freeze({}),
    sourceProximityScores: Object.freeze({}),
    sourceCohortKeys: Object.freeze({}),
    structuralScores: Object.freeze({}),
    graphExpansionScores: Object.freeze({}),
    entitySeedScores: Object.freeze({}),
    pathExpansionScores: Object.freeze({}),
    pathSuppressionScores: Object.freeze({}),
    embeddingSimilarityScores: Object.freeze({}),
    graphSupportCounts: Object.freeze({}),
    budgetPenaltyFactor: 0,
    plasticityFactors: Object.freeze({}),
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: Object.freeze({}),
    governanceCeilingByMemoryId: Object.freeze({}),
    ...overrides
  });
}
function coverageCandidate(input: {
  readonly objectId: string;
  readonly surfaceId: string | null;
  readonly fusedScore: number;
}): FusedCandidate {
  const base = fusedCandidate({ objectId: input.objectId });
  return Object.freeze({
    ...base,
    entry: memory({ object_id: input.objectId, surface_id: input.surfaceId }),
    fusion: Object.freeze({ ...base.fusion, fused_score: input.fusedScore })
  });
}

describe("I-1 — query/evidence-relevance guard on GENERIC path/graph fan-in rescue (gold-blind)", () => {
  it("refuses an irrelevant GENERIC membership-reached sibling (path_expansion, zero relevance, NOT earned co_recalled)", () => {
    // A non-gold sibling reached via a GENERIC structural path / membership hop
    // (NOT the earned co_recalled fan-in carrier) fires path_expansion but
    // carries NO lexical/evidence relevance term and NO earned-fan-in
    // provenance. It must NOT be a rescue candidate: a generic membership hop
    // cannot consume a reserve slot. (reachedViaEarnedCoRecalledFanin defaults
    // to undefined here — this is the displacement-protection I-1 guards.)
    const membershipSibling = fusedCandidate({
      objectId: "membership-sibling",
      contributions: { path_expansion: 0.3 }
    });
    expect(isStructuralRescueCandidate(membershipSibling, supplementary())).toBe(false);
  });

  it("rescues a zero-relevance sibling reached via an EARNED co_recalled fan-in edge (Route 乙)", () => {
    // The earned co_recalled fan-in carrier (R1, threshold-3 sparse) is the
    // INTENDED multi-session fan-in mechanism, not a distractor. A
    // content-disjoint, ZERO-query-relevance sibling reached via that earned
    // edge MUST be rescue-eligible — the bounded exemption that makes Route 乙
    // load-bearing. Identical topology to the GENERIC case above; the ONLY delta
    // is the earned-fan-in provenance, proving the discriminator (not relevance)
    // is what flips eligibility.
    const earnedFaninSibling = fusedCandidate({
      objectId: "earned-fanin-sibling",
      contributions: { path_expansion: 0.3 },
      reachedViaEarnedCoRecalledFanin: true
    });
    expect(isStructuralRescueCandidate(earnedFaninSibling, supplementary())).toBe(true);
  });

  it("admits the SAME fan-in target once it carries a relevance signal (guard is the discriminator)", () => {
    // Identical topology contribution; the only delta is a nonzero lexical-lane
    // relevance term. Proves the guard refuses on ZERO relevance, not on the
    // path_expansion plane itself — so genuine relevant fan-in stays eligible.
    const relevantSibling = fusedCandidate({
      objectId: "relevant-sibling",
      contributions: { path_expansion: 0.3, lexical_fts: 0.02 }
    });
    expect(isStructuralRescueCandidate(relevantSibling, supplementary())).toBe(true);
  });

  it("does not let an irrelevant GENERIC structural sibling displace a rank-4/5 lexical gold", () => {
    // Window of 5. Ranks 1-5 are genuine lexical golds (descending lexical_fts);
    // the rank-4 and rank-5 golds are the displacement targets. An irrelevant
    // GENERIC structural sibling (path_expansion, NOT earned co_recalled) sits
    // buried below the cut with a STRONG path_expansion contribution and zero
    // relevance. Without the guard it would out-rank the buried-set and steal a
    // reserve slot, displacing a lexical gold. This is the displacement
    // protection I-1 exists to enforce, and it is UNCHANGED by the earned
    // co_recalled exemption (this sibling carries no earned-fan-in provenance).
    const lexicalGolds = Array.from({ length: 5 }, (_unused, index) =>
      fusedCandidate({
        objectId: `lexical-gold-${index + 1}`,
        contributions: { lexical_fts: 0.5 - index * 0.05 }
      })
    );
    const irrelevantSibling = fusedCandidate({
      objectId: "generic-structural-sibling",
      contributions: { path_expansion: 0.9 }
    });
    const delivered = [...lexicalGolds, irrelevantSibling];
    const maxEntries = 5;
    const result = reserveStructuralDeliverySlots(delivered, supplementary(), maxEntries, 0);
    const windowIds = result.slice(0, maxEntries).map((candidate) => candidate.entry.object_id);
    // The guard refuses the sibling: it is NOT rescued into the window.
    expect(windowIds).not.toContain("generic-structural-sibling");
    // The rank-4 and rank-5 lexical golds are not displaced.
    expect(windowIds).toContain("lexical-gold-4");
    expect(windowIds).toContain("lexical-gold-5");
    // The reserve is a strict no-op here (no eligible buried structural row).
    expect(result.map((candidate) => candidate.entry.object_id)).toEqual(
      delivered.map((candidate) => candidate.entry.object_id)
    );
  });

  it("DOES rescue a zero-relevance EARNED co_recalled fan-in sibling into the window (Route 乙 delivery)", () => {
    // Same shape as the GENERIC-distractor case above, but the buried sibling
    // was admitted via the EARNED co_recalled fan-in carrier and carries ZERO
    // query relevance. The earned-fan-in exemption admits it and the reserve
    // rescues it past the weakest in-window lexical row — proving the
    // multi-session fan-in mechanism delivers the content-disjoint sibling,
    // while the generic distractor above is still refused. The ONLY delta vs the
    // refused case is the earned-fan-in provenance (gold-blind discriminator).
    const lexicalGolds = Array.from({ length: 5 }, (_unused, index) =>
      fusedCandidate({
        objectId: `lexical-gold-${index + 1}`,
        contributions: { lexical_fts: 0.5 - index * 0.05 }
      })
    );
    const earnedFaninSibling = fusedCandidate({
      objectId: "earned-fanin-sibling",
      contributions: { path_expansion: 0.9 },
      reachedViaEarnedCoRecalledFanin: true
    });
    const delivered = [...lexicalGolds, earnedFaninSibling];
    const maxEntries = 5;
    const result = reserveStructuralDeliverySlots(delivered, supplementary(), maxEntries, 0);
    const windowIds = result.slice(0, maxEntries).map((candidate) => candidate.entry.object_id);
    expect(windowIds).toContain("earned-fanin-sibling");
  });

  it("DOES rescue a relevant buried fan-in target, displacing the weakest in-window lexical row", () => {
    // Same shape as above, but the buried fan-in target ALSO carries a lexical
    // relevance term. The guard now admits it and the reserve rescues it past the
    // weakest in-window lexical row — confirming the guard gates on relevance,
    // not on a blanket refusal of the path plane.
    const lexicalGolds = Array.from({ length: 5 }, (_unused, index) =>
      fusedCandidate({
        objectId: `lexical-gold-${index + 1}`,
        contributions: { lexical_fts: 0.5 - index * 0.05 }
      })
    );
    const relevantFanin = fusedCandidate({
      objectId: "relevant-fanin",
      contributions: { path_expansion: 0.9, lexical_fts: 0.02 }
    });
    const delivered = [...lexicalGolds, relevantFanin];
    const maxEntries = 5;
    const result = reserveStructuralDeliverySlots(delivered, supplementary(), maxEntries, 0);
    const windowIds = result.slice(0, maxEntries).map((candidate) => candidate.entry.object_id);
    expect(windowIds).toContain("relevant-fanin");
  });
});

describe("I-2 — structural reserve honors active sign-aware suppression", () => {
  it("does not rescue an EARNED co_recalled-reached candidate that carries a positive suppression delta", () => {
    // The candidate is path_expansion-dominated, carries a relevance term, AND
    // was admitted via the EARNED co_recalled fan-in carrier — so it clears BOTH
    // the relevance gate AND the earned-fan-in exemption. But the sign-aware
    // suppression collector floored it (contradicts/supersedes-reinforced
    // negative): its pathSuppressionScores delta exceeds its structural
    // contribution. The suppression floor is UPSTREAM of both eligibility
    // branches, so the reserve must still honor that demotion and refuse to
    // resurface the stale/contradicted target — proving the earned exemption
    // does NOT override active suppression (I-2 holds even for earned fan-in).
    const suppressedTarget = fusedCandidate({
      objectId: "suppressed-fanin",
      contributions: { path_expansion: 0.3, lexical_fts: 0.02 },
      reachedViaEarnedCoRecalledFanin: true
    });
    const suppressed = supplementary({
      pathSuppressionScores: Object.freeze({ "suppressed-fanin": 0.5 })
    });
    expect(isStructuralRescueCandidate(suppressedTarget, suppressed)).toBe(false);

    const lexicalRows = Array.from({ length: 5 }, (_unused, index) =>
      fusedCandidate({
        objectId: `lexical-row-${index + 1}`,
        contributions: { lexical_fts: 0.5 - index * 0.05 }
      })
    );
    const delivered = [...lexicalRows, suppressedTarget];
    const result = reserveStructuralDeliverySlots(delivered, suppressed, 5, 0);
    const windowIds = result.slice(0, 5).map((candidate) => candidate.entry.object_id);
    expect(windowIds).not.toContain("suppressed-fanin");
  });

  it("rescues the SAME candidate when no suppression delta is present (suppression is the discriminator)", () => {
    // Identical candidate (earned co_recalled fan-in) and pool, but
    // pathSuppressionScores is empty. The reserve rescues it — proving the
    // refusal above is driven by the suppression delta, not by the candidate
    // failing some other gate.
    const target = fusedCandidate({
      objectId: "suppressed-fanin",
      contributions: { path_expansion: 0.3, lexical_fts: 0.02 },
      reachedViaEarnedCoRecalledFanin: true
    });
    expect(isStructuralRescueCandidate(target, supplementary())).toBe(true);

    const lexicalRows = Array.from({ length: 5 }, (_unused, index) =>
      fusedCandidate({
        objectId: `lexical-row-${index + 1}`,
        contributions: { lexical_fts: 0.5 - index * 0.05 }
      })
    );
    const delivered = [...lexicalRows, target];
    const result = reserveStructuralDeliverySlots(delivered, supplementary(), 5, 0);
    const windowIds = result.slice(0, 5).map((candidate) => candidate.entry.object_id);
    expect(windowIds).toContain("suppressed-fanin");
  });
});
