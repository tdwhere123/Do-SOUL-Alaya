import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEntry, RecallScoreFactors } from "@do-soul/alaya-protocol";
import {
  COMPOSE_COVERAGE_LAMBDA,
  COMPOSE_COVERAGE_SATURATION,
  COMPOSE_EVIDENCE_BETA,
  composeAndOrderByEntity
} from "../../recall/activation-assembly.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import { fineAssess } from "../../recall/fine-assessment.js";
import { buildRecallPolicy } from "../../shared/recall-policy.js";
import type { FineAssessmentCandidate } from "../../recall/fine-assessment-selection.js";
import type { CoarseRecallCandidate, RecallSupplementaryData } from "../../recall/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const FLAG = "ALAYA_RECALL_COMPOSE";

afterEach(() => {
  delete process.env[FLAG];
});

function scoreFactors(): RecallScoreFactors {
  return {
    activation: 0,
    relevance: 0,
    graph_support: 0,
    path_plasticity: 0,
    budget_penalty: 0,
    conflict_penalty: 0
  };
}

function fac(opts: {
  readonly id: string;
  readonly fused: number;
  readonly entities?: readonly string[] | null;
  readonly surface?: string | null;
  readonly run?: string;
  readonly supersededBy?: string | null;
}): FineAssessmentCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(opts.id);
  return {
    entry: createMemoryEntry({
      object_id: opts.id,
      canonical_entities: opts.entities ?? null,
      surface_id: opts.surface ?? null,
      run_id: opts.run ?? "run-1",
      superseded_by: opts.supersededBy ?? null
    }),
    effectiveScore: opts.fused,
    effectiveFactors: scoreFactors(),
    fusion: { ...breakdown, fused_rank: 1, fused_score: opts.fused }
  };
}

function supp(
  sourceCohortKeys: Readonly<Record<string, string>> = {},
  graphSupportCounts: Readonly<Record<string, number>> = {}
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(null),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    sourceProximityScores: {},
    sourceCohortKeys,
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    graphSupportCounts,
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}

function ids(candidates: readonly FineAssessmentCandidate[]): readonly string[] {
  return candidates.map((candidate) => candidate.entry.object_id);
}

describe("composeAndOrderByEntity", () => {
  it("returns an empty list for empty input", () => {
    expect(composeAndOrderByEntity([], supp(), 10)).toEqual([]);
  });

  it("clusters same-entity members, pulling a distant sibling up beside the strongest member", () => {
    const a = fac({ id: "mem-a", fused: 0.5, entities: ["postgres"] });
    const b = fac({ id: "mem-b", fused: 0.4, entities: ["redis"] });
    const c = fac({ id: "mem-c", fused: 0.3, entities: ["postgres"] });
    // Seed order would be a, b, c; entity grouping clusters c with a → a, c, b.
    const out = composeAndOrderByEntity([c, a, b], supp(), 10);
    expect(ids(out)).toEqual(["mem-a", "mem-c", "mem-b"]);
  });

  it("delivers every member exactly once (permutation of the input)", () => {
    const candidates = [
      fac({ id: "mem-a", fused: 0.5, entities: ["postgres"] }),
      fac({ id: "mem-b", fused: 0.4, entities: ["redis"] }),
      fac({ id: "mem-c", fused: 0.3, entities: ["postgres"] }),
      fac({ id: "mem-d", fused: 0.2, entities: null })
    ];
    const out = composeAndOrderByEntity(candidates, supp(), 10);
    expect([...ids(out)].sort()).toEqual(["mem-a", "mem-b", "mem-c", "mem-d"]);
  });

  it("recovers cap-overflow members at the tail in fused order (no drop, full permutation)", () => {
    // groupCap = max(maxEntries=10, DEFAULT_ENTITY_GROUP_CAP=25) = 25; three members overflow the group.
    const cap = 25;
    const sameEntity = Array.from({ length: cap + 3 }, (_, i) =>
      fac({ id: `x${i}`, fused: 1 - i * 0.01, entities: ["x"], surface: `s${i}` })
    );
    const out = composeAndOrderByEntity(sameEntity, supp(), 10);
    expect(out).toHaveLength(sameEntity.length);
    expect([...ids(out)].sort()).toEqual([...ids(sameEntity)].sort());
    // The 3 overflow members sit at the tail, in fused (descending-score) order.
    expect(ids(out).slice(cap)).toEqual(["x25", "x26", "x27"]);
  });

  it("keeps a strong standalone candidate ahead of a weaker multi-session entity group (single-gold safe)", () => {
    const strong = fac({ id: "gold", fused: 0.9, entities: null, surface: "s0" });
    const group = [
      fac({ id: "g1", fused: 0.2, entities: ["topic"], surface: "s1" }),
      fac({ id: "g2", fused: 0.2, entities: ["topic"], surface: "s2" }),
      fac({ id: "g3", fused: 0.2, entities: ["topic"], surface: "s3" })
    ];
    const out = composeAndOrderByEntity([...group, strong], supp(), 10);
    expect(out[0].entry.object_id).toBe("gold");
  });

  it("treats a unique-entity strong candidate as a singleton that outranks a weak group", () => {
    const strong = fac({ id: "gold", fused: 0.9, entities: ["unique-subject"], surface: "s0" });
    const group = [
      fac({ id: "g1", fused: 0.3, entities: ["topic"], surface: "s1" }),
      fac({ id: "g2", fused: 0.25, entities: ["topic"], surface: "s2" })
    ];
    const out = composeAndOrderByEntity([...group, strong], supp(), 10);
    expect(out[0].entry.object_id).toBe("gold");
  });

  it("a singleton receives no coverage bonus, so two singletons order purely by fused score", () => {
    const lower = fac({ id: "lo", fused: 0.40, entities: ["a"], surface: "s1" });
    const higher = fac({ id: "hi", fused: 0.41, entities: ["b"], surface: "s2" });
    const out = composeAndOrderByEntity([lower, higher], supp(), 10);
    expect(ids(out)).toEqual(["hi", "lo"]);
  });

  it("the bounded coverage bonus breaks a best-score tie in favor of the more session-diverse group", () => {
    const diverse = [
      fac({ id: "x1", fused: 0.4, entities: ["x"], surface: "s1" }),
      fac({ id: "x2", fused: 0.35, entities: ["x"], surface: "s2" }),
      fac({ id: "x3", fused: 0.3, entities: ["x"], surface: "s3" })
    ];
    const flat = [
      fac({ id: "y1", fused: 0.4, entities: ["y"], surface: "s9" }),
      fac({ id: "y2", fused: 0.35, entities: ["y"], surface: "s9" })
    ];
    const out = composeAndOrderByEntity([...flat, ...diverse], supp(), 10);
    // Equal best fused (0.4); the 3-session group's bounded bonus seats it first.
    expect(out[0].entry.object_id).toBe("x1");
    expect(ids(out).indexOf("x1")).toBeLessThan(ids(out).indexOf("y1"));
  });

  it("derives session diversity from sourceCohortKeys when present", () => {
    const diverse = [
      fac({ id: "x1", fused: 0.4, entities: ["x"], surface: "same" }),
      fac({ id: "x2", fused: 0.35, entities: ["x"], surface: "same" })
    ];
    const flat = [fac({ id: "y1", fused: 0.4, entities: ["y"], surface: "same" })];
    // Same surface_id would collapse to one session; cohort keys split x1/x2 into two → bonus lifts x.
    const cohorts = { x1: "cohort-1", x2: "cohort-2" };
    const out = composeAndOrderByEntity([...flat, ...diverse], supp(cohorts), 10);
    expect(out[0].entry.object_id).toBe("x1");
  });

  it("the coverage bonus is bounded by lambda and cannot flip a clearly stronger group", () => {
    // Even a maximally diverse weak group only adds COMPOSE_COVERAGE_LAMBDA at saturation.
    expect(COMPOSE_COVERAGE_LAMBDA).toBe(0.05);
    expect(COMPOSE_COVERAGE_SATURATION).toBe(4);
    const stronger = fac({ id: "s", fused: 0.5, entities: ["s"], surface: "s0" });
    const weakDiverse = Array.from({ length: 6 }, (_, i) =>
      fac({ id: `w${i}`, fused: 0.3, entities: ["w"], surface: `sess-${i}` })
    );
    const out = composeAndOrderByEntity([...weakDiverse, stronger], supp(), 10);
    expect(out[0].entry.object_id).toBe("s");
  });

  it("is deterministic across repeated calls", () => {
    const candidates = [
      fac({ id: "mem-a", fused: 0.5, entities: ["postgres"], surface: "s1" }),
      fac({ id: "mem-b", fused: 0.4, entities: ["redis"], surface: "s2" }),
      fac({ id: "mem-c", fused: 0.3, entities: ["postgres"], surface: "s3" })
    ];
    expect(ids(composeAndOrderByEntity(candidates, supp(), 10))).toEqual(
      ids(composeAndOrderByEntity(candidates, supp(), 10))
    );
  });

  it("supportByEvidence: bounded R_E gain seats the higher-graph-support group first on a best-score tie", () => {
    expect(COMPOSE_EVIDENCE_BETA).toBe(0.1);
    const x = fac({ id: "x", fused: 0.4, entities: ["x"], surface: "s1" });
    const y = fac({ id: "y", fused: 0.4, entities: ["y"], surface: "s2" });
    // Equal best fused (0.4); only x carries inbound graph support (count 3 → normalizeGraphSupport 1.0).
    const supported = supp({}, { x: 3 });
    expect(ids(composeAndOrderByEntity([y, x], supported, 10))).toEqual(["x", "y"]);
  });

  it("supportByEvidence is bounded and cannot flip a clearly stronger object-base group", () => {
    const supported = fac({ id: "weak", fused: 0.4, entities: ["w"], surface: "s1" });
    const strongerBase = fac({ id: "strong", fused: 0.5, entities: ["z"], surface: "s2" });
    // weak gets the max R_E gain (×1.1 = 0.44) but still loses to the stronger base (0.5).
    const out = composeAndOrderByEntity([supported, strongerBase], supp({}, { weak: 3 }), 10);
    expect(out[0].entry.object_id).toBe("strong");
  });

  it("arbitrateByGovernance: a member superseded by a co-present winner is demoted below live members", () => {
    const winner = fac({ id: "winner", fused: 0.9, entities: ["topic"], surface: "s1" });
    const stale = fac({ id: "stale", fused: 0.8, entities: ["topic"], surface: "s2", supersededBy: "winner" });
    const other = fac({ id: "other", fused: 0.3, entities: ["misc"], surface: "s3" });
    // Stale ranks 2nd by fused score, but governance sinks it below every non-superseded member.
    const out = composeAndOrderByEntity([winner, stale, other], supp(), 10);
    expect(ids(out)).toEqual(["winner", "other", "stale"]);
    expect(ids(out).indexOf("stale")).toBe(ids(out).length - 1);
  });

  it("does not demote a member whose superseded_by winner is absent from the compose input", () => {
    const a = fac({ id: "a", fused: 0.5, entities: ["e"], surface: "s1", supersededBy: "not-in-pool" });
    const b = fac({ id: "b", fused: 0.4, entities: ["f"], surface: "s2" });
    expect(ids(composeAndOrderByEntity([a, b], supp(), 10))).toEqual(["a", "b"]);
  });
});

// OFF byte-identical + ON-wired through the real fineAssess delivery path.
describe("ALAYA_RECALL_COMPOSE wiring (fineAssess)", () => {
  function memory(id: string, entities: readonly string[] | null): MemoryEntry {
    return createMemoryEntry({
      object_id: id,
      content: "identical pooled recall content for every candidate",
      canonical_entities: entities,
      surface_id: null,
      run_id: "run-1"
    });
  }

  function coarse(entry: MemoryEntry): CoarseRecallCandidate {
    return { entry };
  }

  const FTS_RANKS: Readonly<Record<string, number>> = { "mem-a": 1, "mem-b": 0.6, "mem-c": 0.2 };

  function deliveredOrder(entries: readonly MemoryEntry[]): readonly string[] {
    const policy = buildRecallPolicy({
      runtimeId: "11111111-1111-4111-8111-111111111111",
      taskSurfaceId: "22222222-2222-4222-8222-222222222222",
      maxResults: 10,
      filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
      conflictAwareness: false,
      maxTotalTokens: 100000
    });
    const result = fineAssess({
      candidates: entries.map(coarse),
      policy,
      winnerMemoryIds: new Set<string>(),
      supplementaryData: { ...supp(), ftsRanks: FTS_RANKS },
      tokenEstimator: { estimate: () => 1 },
      now: () => "2026-03-23T00:00:00.000Z",
      warn: () => {}
    });
    return result.candidates.map((candidate) => candidate.object_id);
  }

  const withEntities: readonly MemoryEntry[] = [
    memory("mem-a", ["postgres"]),
    memory("mem-b", ["redis"]),
    memory("mem-c", ["postgres"])
  ];
  const withoutEntities: readonly MemoryEntry[] = [
    memory("mem-a", null),
    memory("mem-b", null),
    memory("mem-c", null)
  ];

  it("OFF: delivery order is byte-identical with and without canonical_entities", () => {
    delete process.env[FLAG];
    const offWith = deliveredOrder(withEntities);
    const offWithout = deliveredOrder(withoutEntities);
    expect(offWith).toEqual(offWithout);
    // Legacy fused order: mem-a (rank 1), mem-b, mem-c — entity-agnostic.
    expect(offWith).toEqual(["mem-a", "mem-b", "mem-c"]);
  });

  it("ON: compose clusters same-entity members (mem-c rises beside mem-a, ahead of mem-b)", () => {
    const off = deliveredOrder(withEntities);
    process.env[FLAG] = "on";
    const on = deliveredOrder(withEntities);
    expect(on).not.toEqual(off);
    expect(on).toEqual(["mem-a", "mem-c", "mem-b"]);
    // OFF keeps mem-b ahead of mem-c; ON flips it via entity clustering.
    expect(off.indexOf("mem-b")).toBeLessThan(off.indexOf("mem-c"));
    expect(on.indexOf("mem-c")).toBeLessThan(on.indexOf("mem-b"));
  });
});
