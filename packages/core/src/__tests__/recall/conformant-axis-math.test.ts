import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { noisyOrDecorrelate } from "../../recall/conformant-evidence-math.js";
import {
  collapseEvidenceRelevance,
  collapsePathInflow
} from "../../recall/conformant-fusion-scoring.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/recall-service-types.js";

const CONF_ENV = [
  "ALAYA_RECALL_CONF_W_PATH", "ALAYA_RECALL_CONF_EVIDENCE_BETA", "ALAYA_RECALL_CONF_FLOOD_CAP",
  "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL", "ALAYA_RECALL_CONF_RHO_PATH", "ALAYA_RECALL_CONF_RHO_EVIDENCE"
] as const;

afterEach(() => {
  for (const name of CONF_ENV) {
    delete process.env[name];
  }
});

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

function evidenceInputs(supports: readonly number[], noise: Partial<RecallSupplementaryData> = {}): {
  readonly candidate: { readonly entry: MemoryEntry; readonly effectiveFactors: { activation: number; relevance: number } };
  readonly supplementaryData: RecallSupplementaryData;
} {
  const evidenceRefs = supports.map((_support, index) => `ev-${index}`);
  return {
    candidate: {
      entry: { object_id: OID, evidence_refs: evidenceRefs } as unknown as MemoryEntry,
      effectiveFactors: { activation: 0, relevance: 0 }
    },
    supplementaryData: {
      ...emptyRecords(),
      evidenceSupportVectorsByMemoryId: {
        [OID]: supports.map((support, index) => ({
          source_kind: "evidence_ref",
          source_id: evidenceRefs[index]!,
          support
        }))
      },
      ...noise
    }
  };
}

describe("NOR_ρ operator (noisyOrDecorrelate)", () => {
  it("empty input collapses to 0", () => {
    expect(noisyOrDecorrelate([], [], 0.5)).toBe(0);
  });

  it("ρ=1 is pure confidence-weighted max", () => {
    expect(noisyOrDecorrelate([0.3, 0.8, 0.5], [1, 1, 1], 1)).toBeCloseTo(0.8, 12);
    expect(noisyOrDecorrelate([0.8], [0.5], 1)).toBeCloseTo(0.4, 12);
    expect(noisyOrDecorrelate([0.95, 0.90], [0.60, 1.00], 1)).toBeCloseTo(0.90, 12);
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
  it("lexical / source-proximity supplementary fields do not affect R_E", () => {
    const bare = collapseEvidenceRelevance(evidenceInputs([2 / 3]), 0.5);
    const withLexicalNoise = collapseEvidenceRelevance(evidenceInputs([2 / 3], {
      ftsRanks: { [OID]: 0.9 }, evidenceFtsRanks: { [OID]: 0.9 },
      trigramFtsRanks: { [OID]: 0.9 }, sourceProximityScores: { [OID]: 0.9 }
    }), 0.5);
    expect(bare).toBeCloseTo(2 / 3, 12);
    expect(withLexicalNoise).toBeCloseTo(bare, 12);
  });

  it("R_E tracks independent evidence-source vectors only", () => {
    expect(collapseEvidenceRelevance(evidenceInputs([1 / 3]), 0.5)).toBeCloseTo(1 / 3, 12);
    expect(collapseEvidenceRelevance(evidenceInputs([1]), 0.5)).toBeCloseTo(1, 12);
    expect(collapseEvidenceRelevance(evidenceInputs([]), 0.5)).toBeCloseTo(0, 12);
    expect(collapseEvidenceRelevance(evidenceInputs([], { graphSupportCounts: { [OID]: 3 } }), 0.5)).toBeCloseTo(0, 12);
  });

  it("R_E is independent-support count only — ρ_ev is inert until a second support exists", () => {
    const base = collapseEvidenceRelevance(evidenceInputs([1 / 3]), 0);
    const atRhoOne = collapseEvidenceRelevance(evidenceInputs([1 / 3]), 1);
    expect(base).toBeCloseTo(1 / 3, 12);
    expect(atRhoOne).toBeCloseTo(base, 12);
  });

  it("decorrelates multiple evidence sources through NOR_ρ", () => {
    expect(collapseEvidenceRelevance(evidenceInputs([0.5, 0.5]), 0.5)).toBeCloseTo(0.625, 12);
  });
});

describe("P2 — Φ path-flood identity (collapsePathInflow)", () => {
  const seed = (relevance: number): ReadonlyMap<string, number> => new Map([["s", relevance]]);

  it("no inflow ⇒ Φ=0", () => {
    expect(collapsePathInflow(undefined, "t", seed(0.9), 1, 3, 0.5)).toBe(0);
  });

  it("a π=0 co-occurrence edge carries no flood even from a strong seed ⇒ Φ=0", () => {
    expect(collapsePathInflow([{ seedObjectId: "s", weight: 0 }], "t", seed(0.9), 1, 3, 0.5)).toBe(0);
  });

  it("a self-loop edge (s = o) never floods itself ⇒ Φ=0", () => {
    expect(collapsePathInflow([{ seedObjectId: "t", weight: 1 }], "t", new Map([["t", 1]]), 1, 3, 0.5)).toBe(0);
  });

  it("a zero-relevance seed carries no flood ⇒ Φ=0", () => {
    expect(collapsePathInflow([{ seedObjectId: "s", weight: 1 }], "t", seed(0), 1, 3, 0.5)).toBe(0);
  });

  it("a relevant seed floods its target, clamped by cap_src then cap_tot", () => {
    expect(collapsePathInflow([{ seedObjectId: "s", weight: 0.5 }], "t", seed(0.8), 1, 3, 0.5)).toBeGreaterThan(0);
    // cap_src clamps one edge's π-flood before the fold.
    expect(collapsePathInflow([{ seedObjectId: "s", weight: 10 }], "t", seed(0.8), 0.2, 3, 0.5)).toBeCloseTo(0.2, 12);
    // cap_tot clamps the folded total.
    expect(collapsePathInflow([{ seedObjectId: "s", weight: 10 }], "t", seed(0.8), 1, 0.3, 0.5)).toBeCloseTo(0.3, 12);
  });

  it("two saturating sources fold by NOR (≤1), never the additive sum", () => {
    const folded = collapsePathInflow(
      [{ seedObjectId: "a", weight: 10 }, { seedObjectId: "b", weight: 10 }],
      "t",
      new Map([["a", 1], ["b", 1]]),
      1,
      3,
      0.5
    );
    expect(folded).toBeCloseTo(1, 12);
  });
});
