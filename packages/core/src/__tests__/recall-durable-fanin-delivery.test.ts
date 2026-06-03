import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  RECALL_FUSION_STREAMS,
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
  // RecallScoreFactors requires relevance + activation; the delivery-reserve
  // helpers never read score_factors, so the minimal valid shape suffices.
  readonly effectiveFactors: { readonly relevance: number; readonly activation: number };
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
    effectiveFactors: { relevance: 0, activation: 0 },
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

describe("durable-edge fan-in stream registration", () => {
  it("does NOT register the retired session_cohort_fanin heuristic stream", () => {
    expect(RECALL_FUSION_STREAMS).not.toContain("session_cohort_fanin");
  });

  it("registers the durable-edge fan-in carriers path_expansion + graph_expansion", () => {
    expect(RECALL_FUSION_STREAMS).toContain("path_expansion");
    expect(RECALL_FUSION_STREAMS).toContain("graph_expansion");
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

  it("prefers an uncovered capsule whose evidence overlaps a path-reached member (durable-edge anchor bonus)", () => {
    // The coverage window is min(maxEntries, 5)=5 here. Fillers 0-4 fill that
    // window WITHOUT carrying ev-shared, so the anchored capsule stays uncovered.
    // A path-reached member (path_expansion stream contribution) sits OUTSIDE the
    // coverage window carrying ev-shared. Two uncovered capsules tie on synthesis
    // FTS rank (0); the anchor bonus must break the tie toward the capsule whose
    // evidence corroborates the path-reached member.
    const fillers = Array.from({ length: 5 }, (_unused, index) =>
      fusedCandidate({ objectId: `filler-${index}`, evidenceRefs: [`other-${index}`] })
    );
    const pathReachedMember = fusedCandidate({
      objectId: "mem-path-reached",
      evidenceRefs: ["ev-shared"],
      contributions: { path_expansion: 0.3 }
    });
    const anchoredCapsule = fusedCandidate({
      objectId: "syn-anchored",
      objectKind: "synthesis_capsule",
      evidenceRefs: ["ev-shared"]
    });
    const unanchoredCapsule = fusedCandidate({
      objectId: "syn-unanchored",
      objectKind: "synthesis_capsule",
      evidenceRefs: ["ev-orphan"]
    });
    // maxEntries 6 reserves up to SYNTHESIS_DELIVERY_RESERVE (2) tail slots; with
    // two uncovered capsules tied on FTS rank, the anchor bonus orders the
    // anchored one ahead of the orphan in the reserved tail.
    const delivered = [...fillers, pathReachedMember, unanchoredCapsule, anchoredCapsule];
    const reserved = reserveSynthesisDeliverySlots(delivered, supplementary(), 6);
    const anchoredPos = reserved.findIndex((c) => c.entry.object_id === "syn-anchored");
    const unanchoredPos = reserved.findIndex((c) => c.entry.object_id === "syn-unanchored");
    expect(anchoredPos).toBeGreaterThanOrEqual(0);
    expect(unanchoredPos).toBeGreaterThanOrEqual(0);
    expect(anchoredPos).toBeLessThan(unanchoredPos);
  });
});

describe("structural reserve — durable-edge path/graph fan-in eligible + bounded", () => {
  it("treats a path_expansion-dominated candidate as a structural rescue candidate", () => {
    const candidate = fusedCandidate({
      objectId: "path-fanin",
      contributions: { path_expansion: 0.3, lexical_fts: 0.05 }
    });
    expect(isStructuralRescueCandidate(candidate)).toBe(true);
  });

  it("treats a graph_expansion-dominated candidate as a structural rescue candidate", () => {
    const candidate = fusedCandidate({
      objectId: "graph-fanin",
      contributions: { graph_expansion: 0.3, lexical_fts: 0.05 }
    });
    expect(isStructuralRescueCandidate(candidate)).toBe(true);
  });

  it("does not rescue a lexical-dominated row that merely carries a small path term", () => {
    const candidate = fusedCandidate({
      objectId: "lexical-filler",
      contributions: { path_expansion: 0.05, lexical_fts: 0.4 }
    });
    expect(isStructuralRescueCandidate(candidate)).toBe(false);
  });

  it("keeps at least one pure-fusion head slot (bounded reserve)", () => {
    // Head rows: pure lexical winners. Buried rows: path-fan-in-dominated, out of window.
    const head = Array.from({ length: 10 }, (_unused, index) =>
      fusedCandidate({
        objectId: `head-${index}`,
        contributions: { lexical_fts: 0.5 - index * 0.01 }
      })
    );
    const buried = Array.from({ length: 3 }, (_unused, index) =>
      fusedCandidate({
        objectId: `buried-${index}`,
        contributions: { path_expansion: 0.4 - index * 0.01 }
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
    // No more than 2 buried path-fan-in reps are pulled into the window.
    const rescued = windowHead.filter((id) => id.startsWith("buried-"));
    expect(rescued.length).toBeLessThanOrEqual(2);
  });
});
