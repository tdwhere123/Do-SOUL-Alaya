import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { applyEvidenceSetDelivery } from "../../recall/evidence-set-optimizer.js";
import { RECALL_FUSION_STREAMS } from "../../recall/recall-service.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/fusion-delivery-scoring.js";
import type {
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallSupplementaryData
} from "../../recall/recall-service-types.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";

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
  readonly content?: string;
  readonly domainTags?: readonly string[];
  readonly dimension?: MemoryDimensionType;
  readonly evidenceRefs?: readonly string[];
  readonly createdAt?: string;
  readonly streamRanks?: Partial<Record<RecallFusionStream, number>>;
}): FusedCandidate {
  const entry = memory({
    object_id: input.objectId,
    surface_id: input.surfaceId ?? null,
    content: input.content ?? "memory content",
    domain_tags: input.domainTags ?? [],
    dimension: input.dimension ?? MemoryDimension.FACT,
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
  queryText: string | null = null,
  sourceCohortKeys: Record<string, string> = {},
  pathSuppressionScores: Record<string, number> = {}
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(queryText),
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
    pathSuppressionScores,
    embeddingSimilarityScores: {},
    graphSupportCounts: {}
  } as unknown as RecallSupplementaryData;
}

function ids(candidates: readonly FusedCandidate[]): string[] {
  return candidates.map((c) => c.entry.object_id);
}

// Head session "A" with six near-equal members and one stronger second-session
// "B" gold buried at rank 8 — the canonical full-gold@5 wall.
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

// force mode (selector="1"/"force") bypasses the multi-fact gate so the legacy
// coverage behavior is exercised directly on probe-free pools.
describe("applyEvidenceSetDelivery force mode", () => {
  it("promotes a buried second-session gold (rank 8) into the top 5", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    const result = applyEvidenceSetDelivery(ordered, supplementary(), 10);
    expect(ids(result).slice(0, 5)).toContain("b8");
  });

  it("always keeps natural rank 1 first", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    const result = applyEvidenceSetDelivery(ordered, supplementary(), 10);
    expect(result[0]!.entry.object_id).toBe("a1");
  });

  it("is a no-op when maxEntries <= 1", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    expect(applyEvidenceSetDelivery(ordered, supplementary(), 1)).toBe(ordered);
  });

  it("never duplicates a candidate in the reordered output", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    const result = applyEvidenceSetDelivery(ordered, supplementary(), 10);
    expect(new Set(ids(result)).size).toBe(ordered.length);
    expect(result).toHaveLength(ordered.length);
  });

  it("preserves the tail order beyond the selected window", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered = buildSingleSessionWallPool();
    const result = applyEvidenceSetDelivery(ordered, supplementary(), 10);
    const selectedKeys = new Set(ids(result).slice(0, 5));
    const tailNatural = ids(ordered).filter((id) => !selectedKeys.has(id));
    expect(ids(result).slice(5)).toEqual(tailNatural);
  });

  it("blocks a low-score noise candidate (below ratio, no stream hit) from promotion", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered: FusedCandidate[] = [candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA" })];
    for (let rank = 2; rank <= 7; rank += 1) {
      ordered.push(candidate({ objectId: `a${rank}`, fusedScore: 0.9, surfaceId: "sA" }));
    }
    ordered.push(candidate({ objectId: "noise", fusedScore: 0.05, surfaceId: "sNoise" }));
    const result = applyEvidenceSetDelivery(ordered, supplementary(), 10);
    expect(ids(result).slice(0, 5)).not.toContain("noise");
  });

  it("admits a buried new-session candidate on a stream hit even below the score ratio", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered: FusedCandidate[] = [candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA" })];
    for (let rank = 2; rank <= 7; rank += 1) {
      ordered.push(candidate({ objectId: `a${rank}`, fusedScore: 0.25, surfaceId: "sA" }));
    }
    ordered.push(
      candidate({ objectId: "emb8", fusedScore: 0.2, surfaceId: "sB", streamRanks: { embedding_similarity: 1 } })
    );
    const result = applyEvidenceSetDelivery(ordered, supplementary(), 10);
    expect(ids(result).slice(0, 5)).toContain("emb8");
  });

  it("stays robust (valid permutation, rank 1 kept) when no candidate carries a session key", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered: FusedCandidate[] = [];
    for (let rank = 1; rank <= 8; rank += 1) {
      ordered.push(candidate({ objectId: `r${rank}`, fusedScore: 1 - rank * 0.05, surfaceId: null }));
    }
    const result = applyEvidenceSetDelivery(ordered, supplementary(), 10);
    expect(result[0]!.entry.object_id).toBe("r1");
    expect(new Set(ids(result)).size).toBe(ordered.length);
    expect(ids(result).sort()).toEqual(ids(ordered).sort());
  });
});

describe("applyEvidenceSetDelivery default mode (multi-fact gate)", () => {
  it("is a no-op (same reference) on a single-fact query", () => {
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "the database url is x" }),
      candidate({ objectId: "a2", fusedScore: 0.6, surfaceId: "sA", content: "database url notes" }),
      candidate({ objectId: "a3", fusedScore: 0.5, surfaceId: "sA", content: "database url more" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("what is the database url"), 10);
    expect(result).toBe(ordered);
  });

  it("is a no-op (same reference) on a probe-free pool that the gate cannot classify", () => {
    const ordered = buildSingleSessionWallPool();
    const result = applyEvidenceSetDelivery(ordered, supplementary(), 10);
    expect(result).toBe(ordered);
  });

  it("promotes a complementary second-session gold for a list-cue multi-fact query", () => {
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "database decisions here" }),
      candidate({ objectId: "a2", fusedScore: 0.6, surfaceId: "sA", content: "database again" }),
      candidate({ objectId: "a3", fusedScore: 0.55, surfaceId: "sA", content: "database again two" }),
      candidate({ objectId: "a4", fusedScore: 0.5, surfaceId: "sA", content: "database again three" }),
      candidate({ objectId: "a5", fusedScore: 0.5, surfaceId: "sA", content: "database again four" }),
      candidate({ objectId: "b6", fusedScore: 0.7, surfaceId: "sB", content: "cache decisions noted" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("list the database and the cache decisions"), 10);
    expect(result[0]!.entry.object_id).toBe("a1");
    expect(ids(result).slice(0, 5)).toContain("b6");
  });

  it("keeps two distinct-sub-clause golds (different lexical hits) together in the top 5", () => {
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "database core" }),
      candidate({ objectId: "a2", fusedScore: 0.6, surfaceId: "sA", content: "database notes" }),
      candidate({ objectId: "a3", fusedScore: 0.55, surfaceId: "sA", content: "database notes two" }),
      candidate({ objectId: "a4", fusedScore: 0.5, surfaceId: "sA", content: "database notes three" }),
      candidate({ objectId: "b6", fusedScore: 0.7, surfaceId: "sB", content: "cache layer" }),
      candidate({ objectId: "c7", fusedScore: 0.7, surfaceId: "sC", content: "queue worker" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("list database cache and queue"), 10);
    expect(result[0]!.entry.object_id).toBe("a1");
    expect(ids(result).slice(0, 5)).toEqual(expect.arrayContaining(["b6", "c7"]));
  });

  it("fires the pool-breadth backstop when the text gives no cue but the pool fans out", () => {
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "database primary record" }),
      candidate({ objectId: "a2", fusedScore: 0.9, surfaceId: "sA", content: "database primary copy" }),
      candidate({ objectId: "b3", fusedScore: 0.85, surfaceId: "sB", content: "cache secondary record" }),
      candidate({ objectId: "a4", fusedScore: 0.5, surfaceId: "sA", content: "database primary again" }),
      candidate({ objectId: "a5", fusedScore: 0.5, surfaceId: "sA", content: "database primary more" }),
      candidate({ objectId: "b8", fusedScore: 0.8, surfaceId: "sB", content: "cache secondary detail" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("database cache record"), 10);
    expect(result[0]!.entry.object_id).toBe("a1");
    expect(new Set(ids(result))).toHaveLength(ordered.length);
  });
});

describe("applyEvidenceSetDelivery env matrix", () => {
  it("off ⇒ same reference even for a multi-fact query", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "off");
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "database decisions" }),
      candidate({ objectId: "b2", fusedScore: 0.8, surfaceId: "sB", content: "cache decisions" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("list database and cache"), 10);
    expect(result).toBe(ordered);
  });

  it("force ⇒ diversifies a probe-free pool the default gate would skip", () => {
    const ordered = buildSingleSessionWallPool();
    expect(applyEvidenceSetDelivery(ordered, supplementary(), 10)).toBe(ordered);
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "force");
    const forced = applyEvidenceSetDelivery(ordered, supplementary(), 10);
    expect(ids(forced).slice(0, 5)).toContain("b8");
  });
});

describe("applyEvidenceSetDelivery regression locks", () => {
  it("is a no-op (same reference) for a list-cue query when the pool is single-session", () => {
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "database url" }),
      candidate({ objectId: "a2", fusedScore: 0.9, surfaceId: "sA", content: "database url two" }),
      candidate({ objectId: "a3", fusedScore: 0.8, surfaceId: "sA", content: "database url three" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("list all the database urls"), 10);
    expect(result).toBe(ordered);
  });

  it("is a no-op (same reference) for a dual-dimension query when the pool is single-session", () => {
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "workflow notes" }),
      candidate({ objectId: "a2", fusedScore: 0.9, surfaceId: "sA", content: "workflow steps" }),
      candidate({ objectId: "a3", fusedScore: 0.8, surfaceId: "sA", content: "workflow more" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("what did we decide about the workflow"), 10);
    expect(result).toBe(ordered);
  });

  it("does not demote a stronger same-session answer for a weak new-session one when the gate fires", () => {
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "workflow decision" }),
      candidate({ objectId: "a2", fusedScore: 0.95, surfaceId: "sA", content: "workflow decision detail" }),
      candidate({ objectId: "b3", fusedScore: 0.7, surfaceId: "sB", content: "unrelated note" }),
      candidate({ objectId: "a4", fusedScore: 0.5, surfaceId: "sA", content: "workflow decision more" }),
      candidate({ objectId: "a5", fusedScore: 0.5, surfaceId: "sA", content: "workflow decision extra" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("what did we decide about the workflow"), 10);
    expect(ids(result).slice(0, 2)).toEqual(["a1", "a2"]);
  });

  it("caps the coverage bonus so a clearly-stronger same-session answer is not demoted by a new-session candidate sharing a fresh term", () => {
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "database cache report" }),
      candidate({ objectId: "a2", fusedScore: 0.95, surfaceId: "sA", content: "database cache detail" }),
      candidate({ objectId: "bLo", fusedScore: 0.74, surfaceId: "sB", content: "database metrics note" }),
      candidate({ objectId: "a4", fusedScore: 0.5, surfaceId: "sA", content: "database cache more" }),
      candidate({ objectId: "a5", fusedScore: 0.5, surfaceId: "sA", content: "database cache extra" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("list the database cache and metrics"), 10);
    expect(ids(result).slice(0, 2)).toEqual(["a1", "a2"]);
  });

  it("rescues a cueless complementary gold whose only query-term hit is novel to the head", () => {
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "database setup notes" }),
      candidate({ objectId: "a2", fusedScore: 0.6, surfaceId: "sA", content: "database config two" }),
      candidate({ objectId: "a3", fusedScore: 0.55, surfaceId: "sA", content: "database config three" }),
      candidate({ objectId: "a4", fusedScore: 0.5, surfaceId: "sA", content: "database config four" }),
      candidate({ objectId: "bGold", fusedScore: 0.7, surfaceId: "sB", content: "cache config detail" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("what database and cache did we use"), 10);
    expect(result[0]!.entry.object_id).toBe("a1");
    expect(ids(result).slice(0, 5)).toContain("bGold");
  });

  it("is a no-op (same reference) for a single-fact query whose cross-session distractor shares only one term", () => {
    const ordered = [
      candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA", content: "database url here" }),
      candidate({ objectId: "a2", fusedScore: 0.95, surfaceId: "sA", content: "database url there" }),
      candidate({ objectId: "off", fusedScore: 0.9, surfaceId: "sB", content: "the url page" })
    ];
    const result = applyEvidenceSetDelivery(ordered, supplementary("what is the database url"), 10);
    expect(result).toBe(ordered);
  });

  it("does not readmit a path-suppressed candidate via its suppressed path stream", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered: FusedCandidate[] = [candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA" })];
    for (let rank = 2; rank <= 7; rank += 1) {
      ordered.push(candidate({ objectId: `a${rank}`, fusedScore: 0.25, surfaceId: "sA" }));
    }
    ordered.push(
      candidate({ objectId: "sup", fusedScore: 0.02, surfaceId: "sB", streamRanks: { path_expansion: 1 } })
    );
    const result = applyEvidenceSetDelivery(ordered, supplementary(null, {}, { sup: 0.5 }), 10);
    expect(ids(result).slice(0, 5)).not.toContain("sup");
  });

  it("still readmits a buried path-stream candidate when it is not suppressed", () => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "1");
    const ordered: FusedCandidate[] = [candidate({ objectId: "a1", fusedScore: 1, surfaceId: "sA" })];
    for (let rank = 2; rank <= 7; rank += 1) {
      ordered.push(candidate({ objectId: `a${rank}`, fusedScore: 0.25, surfaceId: "sA" }));
    }
    ordered.push(
      candidate({ objectId: "path8", fusedScore: 0.2, surfaceId: "sB", streamRanks: { path_expansion: 1 } })
    );
    const result = applyEvidenceSetDelivery(ordered, supplementary(), 10);
    expect(ids(result).slice(0, 5)).toContain("path8");
  });
});
