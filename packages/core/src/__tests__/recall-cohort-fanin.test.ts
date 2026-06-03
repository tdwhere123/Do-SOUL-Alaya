import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  RECALL_FUSION_STREAMS,
  computeCohortFaninScore,
  recallDeliveryReserveTestInternals
} from "../recall-service.js";
import type {
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallSupplementaryData
} from "../recall-service-types.js";
import { compileRecallQueryProbes } from "../recall-query-probes.js";

const {
  selectUncoveredSynthesisCapsules,
  reserveSynthesisDeliverySlots,
  reserveStructuralDeliverySlots,
  synthesisReserveCount,
  buildEmptyRecallFusionBreakdown,
  isStructuralRescueCandidate
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
  readonly effectiveFactors: Record<string, number>;
  readonly structuralScore?: number;
  readonly fusion: Readonly<RecallFusionBreakdown>;
}>;

function fusedCandidate(input: {
  readonly objectId: string;
  readonly objectKind?: "memory_entry" | "synthesis_capsule";
  readonly evidenceRefs?: readonly string[];
  readonly contributions?: Partial<Record<RecallFusionStream, number>>;
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
    effectiveFactors: {},
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
    cohortFaninScores: Object.freeze({}),
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

describe("session_cohort_fanin stream registration", () => {
  it("registers session_cohort_fanin in the production fusion stream list", () => {
    expect(RECALL_FUSION_STREAMS).toContain("session_cohort_fanin");
  });
});

describe("computeCohortFaninScore — fan-in dampening", () => {
  it("returns 0 when the representative is not query-relevant (membership alone never scores)", () => {
    expect(computeCohortFaninScore(0, 17)).toBe(0);
    expect(computeCohortFaninScore(-1, 17)).toBe(0);
  });

  it("boosts a relevant rep above its base repScore, monotonic in cohort size", () => {
    const base = 0.4;
    const small = computeCohortFaninScore(base, 3);
    const large = computeCohortFaninScore(base, 17);
    expect(small).toBeGreaterThan(base);
    expect(large).toBeGreaterThan(small);
  });

  it("log-damps so a 17-member cohort does not dominate a 3-member one", () => {
    const base = 0.4;
    const small = computeCohortFaninScore(base, 3);
    const large = computeCohortFaninScore(base, 17);
    const smallUplift = small - base;
    const largeUplift = large - base;
    // A linear (un-damped) fan-in would scale uplift by raw member count, i.e.
    // 16/2 = 8x. log1p damping must keep the uplift ratio far below that — it is
    // log1p(16)/log1p(2) ≈ 2.58x, comfortably under half the linear ratio.
    const linearRatio = (17 - 1) / (3 - 1);
    expect(largeUplift / smallUplift).toBeLessThan(linearRatio / 2);
  });

  it("clamps to [0,1] so a high-relevance large cohort cannot exceed a normal stream score", () => {
    expect(computeCohortFaninScore(0.95, 50)).toBeLessThanOrEqual(1);
    expect(computeCohortFaninScore(1, 1)).toBeLessThanOrEqual(1);
  });
});

describe("synthesis backstop — fires only for uncovered capsules, not a tail-pin", () => {
  it("drops a capsule from reserve eligibility when a member of its evidence set is already in top-5", () => {
    const delivered = [
      fusedCandidate({ objectId: "mem-cov", evidenceRefs: ["ev-1"] }),
      fusedCandidate({
        objectId: "syn-cov",
        objectKind: "synthesis_capsule",
        evidenceRefs: ["ev-1"]
      })
    ];
    const uncovered = selectUncoveredSynthesisCapsules(delivered, 10);
    expect(uncovered).toHaveLength(0);
    expect(synthesisReserveCount(delivered, 10)).toBe(0);
    // No reserve fires: the delivery order is returned unchanged.
    expect(reserveSynthesisDeliverySlots(delivered, supplementary(), 10)).toEqual(delivered);
  });

  it("reserves a tail slot for a capsule whose evidence set reached no top-5 member", () => {
    const fillers = Array.from({ length: 6 }, (_unused, index) =>
      fusedCandidate({ objectId: `filler-${index}`, evidenceRefs: [`other-${index}`] })
    );
    const capsule = fusedCandidate({
      objectId: "syn-uncov",
      objectKind: "synthesis_capsule",
      evidenceRefs: ["ev-uncovered"]
    });
    const delivered = [...fillers, capsule];
    const uncovered = selectUncoveredSynthesisCapsules(delivered, 5);
    expect(uncovered.map((candidate) => candidate.entry.object_id)).toEqual(["syn-uncov"]);
    const reserved = reserveSynthesisDeliverySlots(delivered, supplementary(), 5);
    // The capsule is pulled into the 5-entry window (it was at index 6, outside it).
    const windowIds = reserved.slice(0, 5).map((candidate) => candidate.entry.object_id);
    expect(windowIds).toContain("syn-uncov");
  });
});

describe("structural reserve — session_cohort_fanin eligible + bounded", () => {
  it("treats a session_cohort_fanin-dominated candidate as a structural rescue candidate", () => {
    const candidate = fusedCandidate({
      objectId: "cohort-rep",
      contributions: { session_cohort_fanin: 0.3, lexical_fts: 0.05 }
    });
    expect(isStructuralRescueCandidate(candidate)).toBe(true);
  });

  it("does not rescue a lexical-dominated row that merely carries a small cohort term", () => {
    const candidate = fusedCandidate({
      objectId: "lexical-filler",
      contributions: { session_cohort_fanin: 0.05, lexical_fts: 0.4 }
    });
    expect(isStructuralRescueCandidate(candidate)).toBe(false);
  });

  it("keeps at least one pure-fusion head slot (bounded reserve)", () => {
    // Head rows: pure lexical winners. Buried rows: cohort-fanin-dominated, out of window.
    const head = Array.from({ length: 10 }, (_unused, index) =>
      fusedCandidate({
        objectId: `head-${index}`,
        contributions: { lexical_fts: 0.5 - index * 0.01 }
      })
    );
    const buried = Array.from({ length: 3 }, (_unused, index) =>
      fusedCandidate({
        objectId: `buried-${index}`,
        contributions: { session_cohort_fanin: 0.4 - index * 0.01 }
      })
    );
    const delivered = [...head, ...buried];
    const maxEntries = 10;
    const result = reserveStructuralDeliverySlots(delivered, maxEntries, 0);
    // Reserve is capped at STRUCTURAL_DELIVERY_RESERVE (2) and at maxEntries-1,
    // so at least one of the original head rows survives in the window head.
    const windowHead = result.slice(0, maxEntries).map((candidate) => candidate.entry.object_id);
    const headSurvivors = windowHead.filter((id) => id.startsWith("head-"));
    expect(headSurvivors.length).toBeGreaterThanOrEqual(1);
    // No more than 2 buried cohort reps are pulled into the window.
    const rescued = windowHead.filter((id) => id.startsWith("buried-"));
    expect(rescued.length).toBeLessThanOrEqual(2);
  });
});
