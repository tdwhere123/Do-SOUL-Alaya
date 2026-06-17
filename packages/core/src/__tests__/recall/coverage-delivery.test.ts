import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { applyCoverageDeliverySelection } from "../../recall/coverage-delivery.js";
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

const { buildEmptyRecallFusionBreakdown } = recallDeliveryReserveTestInternals;

function emptyStreamRanks(): Record<RecallFusionStream, number | null> {
  return Object.fromEntries(RECALL_FUSION_STREAMS.map((stream) => [stream, null])) as Record<
    RecallFusionStream,
    number | null
  >;
}

function memory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "obj",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.FACT,
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

type FusedCandidate = Readonly<{
  readonly entry: Readonly<MemoryEntry>;
  readonly fusion: Readonly<RecallFusionBreakdown>;
}>;

function candidate(input: {
  readonly objectId: string;
  readonly fusedScore: number;
  readonly surfaceId?: string | null;
  readonly evidenceRefs?: readonly string[];
  readonly createdAt?: string;
  readonly streamRanks?: Partial<Record<RecallFusionStream, number>>;
}): FusedCandidate {
  const entry = memory({
    object_id: input.objectId,
    surface_id: input.surfaceId ?? null,
    evidence_refs: input.evidenceRefs ?? [],
    ...(input.createdAt === undefined ? {} : { created_at: input.createdAt })
  });
  const breakdown = buildEmptyRecallFusionBreakdown(input.objectId);
  return Object.freeze({
    entry,
    fusion: Object.freeze({
      ...breakdown,
      per_stream_rank: Object.freeze({
        ...emptyStreamRanks(),
        ...(input.streamRanks ?? {})
      }) as RecallFusionBreakdown["per_stream_rank"],
      fused_score: input.fusedScore
    })
  });
}

function supplementary(
  sourceCohortKeys: Record<string, string> = {}
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
    graphSupportCounts: {}
  } as unknown as RecallSupplementaryData;
}

function ids(candidates: readonly FusedCandidate[]): string[] {
  return candidates.map((c) => c.entry.object_id);
}

// A head session "A" with six near-equal members and one stronger second-session
// "B" gold buried at rank 8 — the canonical full-gold@5 wall the selector targets.
function buildSingleSessionWallPool(): FusedCandidate[] {
  const pool: FusedCandidate[] = [
    candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA" })
  ];
  for (let rank = 2; rank <= 7; rank += 1) {
    pool.push(candidate({ objectId: `a${rank}`, fusedScore: 0.5, surfaceId: "sA" }));
  }
  pool.push(candidate({ objectId: "b8", fusedScore: 0.7, surfaceId: "sB" }));
  for (let rank = 9; rank <= 12; rank += 1) {
    pool.push(candidate({ objectId: `a${rank}`, fusedScore: 0.45, surfaceId: "sA" }));
  }
  return pool;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("applyCoverageDeliverySelection", () => {
  it("promotes a buried second-session gold (rank 8) into the top 5 when enabled", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    const result = applyCoverageDeliverySelection(ordered, supplementary(), 10);
    expect(ids(result).slice(0, 5)).toContain("b8");
  });

  it("always keeps natural rank 1 first when enabled", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    const result = applyCoverageDeliverySelection(ordered, supplementary(), 10);
    expect(result[0]!.entry.object_id).toBe("a1");
  });

  it("is a no-op (same reference) when the selector env is off", () => {
    const ordered = buildSingleSessionWallPool();
    const result = applyCoverageDeliverySelection(ordered, supplementary(), 10);
    expect(result).toBe(ordered);
  });

  it("is a no-op when maxEntries <= 1", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    expect(applyCoverageDeliverySelection(ordered, supplementary(), 1)).toBe(ordered);
  });

  it("never duplicates a candidate in the reordered output", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    const result = applyCoverageDeliverySelection(ordered, supplementary(), 10);
    expect(new Set(ids(result)).size).toBe(ordered.length);
    expect(result).toHaveLength(ordered.length);
  });

  it("preserves the tail order beyond the selected window", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    const result = applyCoverageDeliverySelection(ordered, supplementary(), 10);
    const selectedKeys = new Set(ids(result).slice(0, 5));
    const tailNatural = ids(ordered).filter((id) => !selectedKeys.has(id));
    const tailResult = ids(result).slice(5);
    expect(tailResult).toEqual(tailNatural);
  });

  it("blocks a low-score noise candidate (below ratio, no stream hit) from promotion", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered: FusedCandidate[] = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA" })
    ];
    for (let rank = 2; rank <= 7; rank += 1) {
      ordered.push(candidate({ objectId: `a${rank}`, fusedScore: 0.9, surfaceId: "sA" }));
    }
    // New session but score far below the 0.65 ratio and carrying no stream hit.
    ordered.push(candidate({ objectId: "noise", fusedScore: 0.05, surfaceId: "sNoise" }));
    const result = applyCoverageDeliverySelection(ordered, supplementary(), 10);
    expect(ids(result).slice(0, 5)).not.toContain("noise");
  });

  it("admits a buried new-session candidate on a stream hit even below the score ratio", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered: FusedCandidate[] = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA" })
    ];
    // Weak same-session tail so the buried second-session candidate wins on
    // coverage; below the 0.65 ratio it only reaches the contest via its hit.
    for (let rank = 2; rank <= 7; rank += 1) {
      ordered.push(candidate({ objectId: `a${rank}`, fusedScore: 0.25, surfaceId: "sA" }));
    }
    ordered.push(
      candidate({
        objectId: "emb8",
        fusedScore: 0.2,
        surfaceId: "sB",
        streamRanks: { embedding_similarity: 1 }
      })
    );
    const result = applyCoverageDeliverySelection(ordered, supplementary(), 10);
    expect(ids(result).slice(0, 5)).toContain("emb8");
  });

  it("stays robust (valid permutation, rank 1 kept) when no candidate carries a session key", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered: FusedCandidate[] = [];
    for (let rank = 1; rank <= 8; rank += 1) {
      ordered.push(candidate({ objectId: `r${rank}`, fusedScore: 1 - rank * 0.05 }));
    }
    const result = applyCoverageDeliverySelection(ordered, supplementary(), 10);
    expect(result[0]!.entry.object_id).toBe("r1");
    expect(new Set(ids(result)).size).toBe(ordered.length);
    expect(ids(result).sort()).toEqual(ids(ordered).sort());
  });
});

describe("coverage selection is measurable", () => {
  it("surfaces a buried second-session rank as a promotion into the top K", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    const result = applyCoverageDeliverySelection(ordered, supplementary(), 10);
    const naturalRank = new Map(ids(ordered).map((id, index) => [id, index + 1]));
    const topK = ids(result).slice(0, 5);
    const promotedFromRank = topK
      .map((id) => naturalRank.get(id)!)
      .filter((rank) => rank > 5);
    const sessions = new Set(result.slice(0, 5).map((c) => c.entry.surface_id ?? c.entry.run_id));
    expect(promotedFromRank).toContain(8);
    expect(sessions.size).toBe(2);
  });
});
