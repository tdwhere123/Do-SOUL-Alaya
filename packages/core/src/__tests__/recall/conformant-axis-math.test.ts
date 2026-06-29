import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { noisyOrDecorrelate, type FloodStreamScores } from "../../recall/flood-fusion-scoring.js";
import {
  assembleCompositionalScores,
  collapseEvidenceRelevance,
  collapseObjectRelevance,
  resolveConformantStaleGovernance,
  type SeededCandidate
} from "../../recall/conformant-fusion-scoring.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import type {
  FusionContributionCandidate,
  ResolvedRecallFusionWeights
} from "../../recall/fusion-delivery-adaptive-scoring.js";
import type { RecallFusionStream, RecallSupplementaryData } from "../../recall/recall-service-types.js";

const CONF_ENV = [
  "ALAYA_RECALL_CONF_W_PATH", "ALAYA_RECALL_CONF_EVIDENCE_BETA", "ALAYA_RECALL_CONF_FLOOD_CAP",
  "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL", "ALAYA_RECALL_CONF_RHO_LEX", "ALAYA_RECALL_CONF_RHO_SUB",
  "ALAYA_RECALL_CONF_RHO_PATH", "ALAYA_RECALL_CONF_RHO_EVIDENCE", "ALAYA_RECALL_CONF_ECHO",
  "ALAYA_RECALL_CONF_STALE", "ALAYA_RECALL_CONF_C_SURF", "ALAYA_RECALL_CONF_C_EMB"
] as const;

afterEach(() => {
  for (const name of CONF_ENV) {
    delete process.env[name];
  }
});

type TestInputs = {
  readonly candidate: FusionContributionCandidate;
  readonly candidateKey: string;
  readonly scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores>;
  readonly resolved: ResolvedRecallFusionWeights;
  readonly supplementaryData: RecallSupplementaryData;
};

const KEY = "k1";
const OID = "o1";

function emptyRecords(): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("what is the staging database password"),
    ftsRanks: {}, trigramFtsRanks: {}, synthesisFtsRanks: {}, evidenceFtsRanks: {},
    sourceProximityScores: {}, sourceCohortKeys: {}, structuralScores: {},
    graphExpansionScores: {}, entitySeedScores: {}, pathExpansionScores: {},
    pathSuppressionScores: {}, embeddingSimilarityScores: {}, graphSupportCounts: {},
    budgetPenaltyFactor: 0, plasticityFactors: {}, graphAndPathColdScore: 0,
    recallsEdgeCount: 0, weightTransferAmount: 0, evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}

// Build CollapseInputs whose per-stream relevance equals the requested value: streamMax=1 so norm=value, and an
// injected source-proximity makes the candidate independently supported so lexical lane reliability stays 1.
function buildInputs(
  streams: Partial<Record<RecallFusionStream, number>>,
  opts: { readonly embedding?: number; readonly query?: string; readonly supportCount?: number } = {}
): TestInputs {
  const scoresByStream = new Map<RecallFusionStream, FloodStreamScores>();
  for (const [stream, value] of Object.entries(streams)) {
    scoresByStream.set(stream as RecallFusionStream, {
      scoreByKey: new Map([[KEY, value as number]]),
      max: 1
    });
  }
  const effectiveFactors = opts.embedding === undefined
    ? { activation: 0, relevance: 0 }
    : { activation: 0, relevance: 0, embedding_similarity: opts.embedding };
  return {
    candidate: {
      entry: { object_id: OID, evidence_refs: [] } as unknown as MemoryEntry,
      effectiveFactors
    },
    candidateKey: KEY,
    scoresByStream,
    resolved: { kByStream: {}, weights: {} } as unknown as ResolvedRecallFusionWeights,
    supplementaryData: {
      ...emptyRecords(),
      ...(opts.query !== undefined ? { queryProbes: compileRecallQueryProbes(opts.query) } : {}),
      sourceProximityScores: { [OID]: 1 },
      ...(opts.supportCount !== undefined ? { graphSupportCounts: { [OID]: opts.supportCount } } : {})
    }
  };
}

describe("NOR_ρ operator (noisyOrDecorrelate)", () => {
  it("empty input collapses to 0", () => {
    expect(noisyOrDecorrelate([], [], 0.5)).toBe(0);
  });

  it("ρ=1 is pure (confidence-weighted) max — the largest value alone survives", () => {
    expect(noisyOrDecorrelate([0.3, 0.8, 0.5], [1, 1, 1], 1)).toBeCloseTo(0.8, 12);
    expect(noisyOrDecorrelate([0.8], [0.5], 1)).toBeCloseTo(0.4, 12);
  });

  it("ρ=0 is the full noisy-OR 1−∏(1−cᵢxᵢ)", () => {
    expect(noisyOrDecorrelate([0.5, 0.5], [1, 1], 0)).toBeCloseTo(0.75, 12);
    expect(noisyOrDecorrelate([0.4, 0.2], [1, 1], 0)).toBeCloseTo(1 - 0.6 * 0.8, 12);
  });

  it("stays bounded in [0,1] even with out-of-range inputs", () => {
    const result = noisyOrDecorrelate([2, 0.5, -1], [1, 1, 1], 0);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
    expect(result).toBeCloseTo(1, 12);
  });

  it("appending a 0 support is a no-op", () => {
    const base = noisyOrDecorrelate([0.6, 0.3], [1, 1], 0.5);
    const padded = noisyOrDecorrelate([0.6, 0.3, 0], [1, 1, 1], 0.5);
    expect(padded).toBeCloseTo(base, 12);
  });

  it("is monotone non-decreasing in each support", () => {
    expect(noisyOrDecorrelate([0.6, 0.3], [1, 1], 0.5))
      .toBeLessThanOrEqual(noisyOrDecorrelate([0.7, 0.3], [1, 1], 0.5));
  });

  it("redundant-view marginal gain shrinks as ρ→1 (P1: ∝ 1−ρ)", () => {
    const gainAt = (rho: number): number =>
      noisyOrDecorrelate([0.6, 0.6], [1, 1], rho) - noisyOrDecorrelate([0.6], [1], rho);
    expect(gainAt(0)).toBeGreaterThan(gainAt(0.6));
    expect(gainAt(0.6)).toBeGreaterThan(gainAt(1));
    expect(gainAt(1)).toBeCloseTo(0, 12);
  });
});

describe("P1 — R_E is query-lexical orthogonal (∂R_E/∂L = 0)", () => {
  it("R_E depends on session/source support, never on the lexical or evidence_fts streams", () => {
    const bare = collapseEvidenceRelevance(buildInputs({ source_proximity: 0.7 }), 0.5);
    const withLexicalNoise = collapseEvidenceRelevance(
      buildInputs({ source_proximity: 0.7, lexical_fts: 0.9, evidence_fts: 0.9, trigram_fts: 0.9 }),
      0.5
    );
    expect(bare).toBeCloseTo(0.7, 12);
    expect(withLexicalNoise).toBeCloseTo(bare, 12);
  });

  it("R_E still tracks its own support strength", () => {
    expect(collapseEvidenceRelevance(buildInputs({ source_proximity: 0.3 }), 0.5)).toBeCloseTo(0.3, 12);
  });

  it("R_E folds the query-orthogonal independent-support count, so ρ_ev is live (2-stream NOR)", () => {
    // graphSupportCounts is structural (inbound edge tally), never reads the query; count 1 → 1/3 normalized.
    const base = collapseEvidenceRelevance(buildInputs({ source_proximity: 0.5 }), 0);
    const corroborated = collapseEvidenceRelevance(buildInputs({ source_proximity: 0.5 }, { supportCount: 1 }), 0);
    const pureMax = collapseEvidenceRelevance(buildInputs({ source_proximity: 0.5 }, { supportCount: 1 }), 1);
    expect(base).toBeCloseTo(0.5, 12);
    // ρ_ev=0 corroborates the two supports (full noisy-OR); ρ_ev=1 keeps the max alone — the knob is live.
    expect(corroborated).toBeCloseTo(1 - (1 - 0.5) * (1 - 1 / 3), 12);
    expect(pureMax).toBeCloseTo(0.5, 12);
    expect(corroborated).toBeGreaterThan(pureMax);
  });
});

describe("P2 — candidate-end has no free votes", () => {
  it("R_O(o)=0 with only a π=0 co-occurrence edge (even from a strong seed) ⇒ Φ=0 ⇒ A=0 ⇒ S=0", () => {
    const seeded: readonly SeededCandidate[] = [
      { candidateKey: "s", objectId: "s", object: 0.9, evidence: 0 },
      { candidateKey: "t", objectId: "t", object: 0, evidence: 0 }
    ];
    const ctx = assembleCompositionalScores(seeded, { t: [{ seedObjectId: "s", weight: 0 }] });
    expect(ctx.raByKey.get("t")!.path).toBe(0);
    expect(ctx.scoreByKey.get("t")).toBe(0);
  });

  it("a self-loop inflow edge (s = o) never floods itself", () => {
    const seeded: readonly SeededCandidate[] = [{ candidateKey: "t", objectId: "t", object: 0, evidence: 0 }];
    const ctx = assembleCompositionalScores(seeded, { t: [{ seedObjectId: "t", weight: 1 }] });
    expect(ctx.raByKey.get("t")!.path).toBe(0);
    expect(ctx.scoreByKey.get("t")).toBe(0);
  });
});

describe("P3 — identity collapse (no silent substitution)", () => {
  it("R_E→0 ⇒ S = ω·A (g(0)=1 never penalizes)", () => {
    const ctx = assembleCompositionalScores([{ candidateKey: "o", objectId: "o", object: 0.5, evidence: 0 }], undefined);
    expect(ctx.scoreByKey.get("o")).toBeCloseTo(0.5, 12);
  });

  it("Φ→0 ⇒ A = R_O, so S = R_O·g(R_E)", () => {
    const ctx = assembleCompositionalScores([{ candidateKey: "o", objectId: "o", object: 0.5, evidence: 0.4 }], undefined);
    expect(ctx.raByKey.get("o")!.path).toBe(0);
    expect(ctx.scoreByKey.get("o")).toBeCloseTo(0.5 * (1 + 0.5 * 0.4), 12);
  });

  it("all axes collapse (Φ=0, R_E=0, ω=1) ⇒ S = R_O", () => {
    const ctx = assembleCompositionalScores([{ candidateKey: "o", objectId: "o", object: 0.5, evidence: 0 }], undefined);
    expect(ctx.scoreByKey.get("o")).toBeCloseTo(0.5, 12);
  });

  it("ω scales S as a clean governance multiplier (winner=1 / stale=δ / contested-loser=0)", () => {
    const seeded: readonly SeededCandidate[] = [
      { candidateKey: "win", objectId: "win", object: 0.8, evidence: 0 },
      { candidateKey: "stale", objectId: "stale", object: 0.8, evidence: 0 },
      { candidateKey: "loser", objectId: "loser", object: 0.8, evidence: 0 }
    ];
    const delta = resolveConformantStaleGovernance();
    const governance = new Map<string, number>([["win", 1], ["stale", delta], ["loser", 0]]);
    const ctx = assembleCompositionalScores(seeded, undefined, governance);
    expect(ctx.scoreByKey.get("win")).toBeCloseTo(0.8, 12);
    expect(ctx.scoreByKey.get("stale")).toBeCloseTo(0.8 * delta, 12);
    expect(ctx.scoreByKey.get("loser")).toBe(0);
    expect(delta).toBe(0.5);
  });

  it("embedding co-facet lifts R_O (能抬) and absence never demotes it (不压)", () => {
    // multi_fact: c_surf·R_surf = 0.9·0.6 = 0.54; a strong embedding (R_emb=0.9, c_emb=0.7) lifts via cross-facet noisy-OR.
    const surfaceOnly = collapseObjectRelevance(buildInputs({ lexical_fts: 0.6 }), 1, null, "multi_fact", 0.6, 0.5);
    const lifted = collapseObjectRelevance(buildInputs({ lexical_fts: 0.6 }, { embedding: 0.9 }), 1, null, "multi_fact", 0.6, 0.5);
    expect(surfaceOnly).toBeCloseTo(0.54, 12);
    expect(lifted).toBeCloseTo(1 - (1 - 0.9 * 0.6) * (1 - 0.7 * 0.9), 12);
    expect(lifted).toBeGreaterThan(surfaceOnly);
    // A near-zero embedding can never push R_O below the surface-only floor.
    const faint = collapseObjectRelevance(buildInputs({ lexical_fts: 0.6 }, { embedding: 0.01 }), 1, null, "multi_fact", 0.6, 0.5);
    expect(faint).toBeGreaterThanOrEqual(surfaceOnly);
  });

  it("single_fact zeroes the embedding facet (c_emb=0): R_emb absence and presence are identical", () => {
    const withEmbedding = collapseObjectRelevance(buildInputs({ lexical_fts: 0.6 }, { embedding: 0.9 }), 1, null, "single_fact", 0.6, 0.5);
    const withoutEmbedding = collapseObjectRelevance(buildInputs({ lexical_fts: 0.6 }), 1, null, "single_fact", 0.6, 0.5);
    expect(withoutEmbedding).toBeCloseTo(0.54, 12);
    expect(withEmbedding).toBeCloseTo(withoutEmbedding, 12);
  });

  it("embedding absent (R_emb=0) is the identity factor: R_O equals the surface-only collapse", () => {
    const withoutEmbedding = collapseObjectRelevance(buildInputs({ lexical_fts: 0.6 }), 1, null, "multi_fact", 0.6, 0.5);
    const zeroPool = collapseObjectRelevance(buildInputs({ lexical_fts: 0.6 }, { embedding: 0.9 }), 0, null, "multi_fact", 0.6, 0.5);
    expect(zeroPool).toBeCloseTo(withoutEmbedding, 12);
  });

  it("prob-OR activation A = 1 − (1−R_O)(1−W_P·Φ); S = ω·A·(1+β·R_E)", () => {
    const seeded: readonly SeededCandidate[] = [
      { candidateKey: "seed", objectId: "seed", object: 1, evidence: 0 },
      { candidateKey: "o", objectId: "o", object: 0.5, evidence: 0 }
    ];
    const ctx = assembleCompositionalScores(seeded, { o: [{ seedObjectId: "seed", weight: 0.5 }] });
    expect(ctx.raByKey.get("o")!.object).toBeCloseTo(0.5, 12);
    expect(ctx.raByKey.get("o")!.path).toBeCloseTo(0.5, 12);
    // A = 1 − (1−0.5)(1 − 0.6·0.5) = 0.65; R_E=0 ⇒ S = A.
    expect(ctx.scoreByKey.get("o")).toBeCloseTo(0.65, 12);
  });

  it("evidence boosts multiplicatively: S = R_O·(1+β·R_E)", () => {
    const ctx = assembleCompositionalScores([{ candidateKey: "o", objectId: "o", object: 0.4, evidence: 0.6 }], undefined);
    expect(ctx.scoreByKey.get("o")).toBeCloseTo(0.4 * (1 + 0.5 * 0.6), 12);
  });
});

describe("P4 — single_fact relative gate (ρ_lex→1 pure max)", () => {
  const goldInputs = (): TestInputs => buildInputs({ lexical_fts: 0.8 });
  // A co-topical distractor that fires on many correlated lexical views but is individually weaker than gold.
  const distractorInputs = (): TestInputs =>
    buildInputs({ lexical_fts: 0.75, trigram_fts: 0.75, evidence_fts: 0.75 });

  it("co-topical multi-firing does not out-rank a magnitude-dominant gold (R_surf 0.75 < 0.80)", () => {
    const gold = collapseObjectRelevance(goldInputs(), 1, null, "single_fact", 0.6, 0.5);
    const distractor = collapseObjectRelevance(distractorInputs(), 1, null, "single_fact", 0.6, 0.5);
    // single_fact: pure-max R_surf scaled by c_surf=0.9; the firing count is ignored, ordering preserved.
    expect(gold).toBeCloseTo(0.72, 12);
    expect(distractor).toBeCloseTo(0.675, 12);
    expect(gold).toBeGreaterThan(distractor);
  });

  it("ρ_lex=1 ignores the firing count; ρ_lex<1 (multi_fact) lets the views corroborate", () => {
    const distractorSingle = collapseObjectRelevance(distractorInputs(), 1, null, "single_fact", 0.6, 0.5);
    const distractorMulti = collapseObjectRelevance(distractorInputs(), 1, null, "multi_fact", 0.6, 0.5);
    expect(distractorSingle).toBeCloseTo(0.675, 12);
    expect(distractorMulti).toBeGreaterThan(distractorSingle);
    // Corroboration is allowed for multi_fact ranking; coverage/de-dup is handed to the delivery stage.
    expect(distractorMulti).toBeGreaterThan(collapseObjectRelevance(goldInputs(), 1, null, "multi_fact", 0.6, 0.5));
  });
});
