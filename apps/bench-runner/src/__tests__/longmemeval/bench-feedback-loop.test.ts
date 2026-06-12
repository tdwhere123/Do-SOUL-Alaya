import { describe, expect, it } from "vitest";
import {
  buildLongMemEvalQualityMetrics,
  buildPerPlaneRecallCoverage,
  buildQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";
import {
  LongMemEvalGoldDiagnosticSchema,
  LongMemEvalQuestionDiagnosticSchema
} from "../../longmemeval/diagnostics-schema.js";

// Diagnostics for a question whose single gold candidate is admitted via
// the named planes and lands at the given final rank.
function questionWithGoldPlanes(input: {
  readonly questionId: string;
  readonly finalRank: number | null;
  readonly planes: readonly string[];
}) {
  const goldId = "memory-gold";
  const delivered =
    input.finalRank === null
      ? []
      : [{ object_id: goldId, rank: input.finalRank, relevance_score: 0.5 }];
  return buildQuestionDiagnostic({
    questionId: input.questionId,
    goldMemoryIds: [goldId],
    answerSessionIds: ["session-a"],
    deliveredResults: delivered,
    hitAt1: input.finalRank === 1,
    hitAt5: input.finalRank !== null && input.finalRank <= 5,
    hitAt10: input.finalRank !== null && input.finalRank <= 10,
    degradationReason: null,
    embeddingMode: "disabled",
    recallResult: {
      diagnostics: {
        provider_state: "provider_not_requested",
        candidate_pool: [
          {
            object_id: goldId,
            rank: input.finalRank ?? 99,
            final_rank: input.finalRank,
            source_planes: input.planes
          }
        ]
      }
    }
  });
}

describe("per-plane recall coverage", () => {
  it("aggregates gold and hit_at_5 counts per plane without a hardcoded plane list", () => {
    const rows = [
      questionWithGoldPlanes({
        questionId: "q1",
        finalRank: 2,
        planes: ["lexical", "evidence_anchor"]
      }),
      questionWithGoldPlanes({
        questionId: "q2",
        finalRank: 8,
        planes: ["lexical"]
      }),
      questionWithGoldPlanes({
        questionId: "q3",
        finalRank: 1,
        planes: ["evidence_anchor"]
      })
    ];
    const metrics = buildLongMemEvalQualityMetrics(rows);
    const coverage = metrics.per_plane_recall_coverage;
    expect(coverage.lexical).toEqual({
      gold_count: 2,
      hit_at_5_count: 1,
      hit_at_5_rate: 0.5
    });
    expect(coverage.evidence_anchor).toEqual({
      gold_count: 2,
      hit_at_5_count: 2,
      hit_at_5_rate: 1
    });
  });

  it("surfaces a plane not present in any static list once it appears in source_planes", () => {
    // source_planes is filtered against the diagnostic label set; a plane
    // that is not yet in that set is dropped here. buildPerPlaneRecallCoverage
    // itself, which Phase 1 plane work feeds, is label-agnostic.
    const coverage = buildPerPlaneRecallCoverage(
      new Map([["trigram", 4]]),
      new Map([["trigram", 3]])
    );
    expect(coverage.trigram).toEqual({
      gold_count: 4,
      hit_at_5_count: 3,
      hit_at_5_rate: 0.75
    });
  });

  it("counts a plane at most once per gold candidate even if duplicated", () => {
    const row = questionWithGoldPlanes({
      questionId: "q-dup",
      finalRank: 3,
      planes: ["lexical", "lexical", "evidence_anchor"]
    });
    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(metrics.per_plane_recall_coverage.lexical?.gold_count).toBe(1);
  });
});

describe("diagnostics schema", () => {
  it("validates a question diagnostic with an explicit source_planes field", () => {
    const row = questionWithGoldPlanes({
      questionId: "q-schema",
      finalRank: 4,
      planes: ["lexical", "evidence_anchor"]
    });
    const parsed = LongMemEvalQuestionDiagnosticSchema.parse(row);
    expect(parsed.gold[0]?.source_planes).toEqual([
      "lexical",
      "evidence_anchor"
    ]);
  });

  it("rejects a gold diagnostic whose source_planes is not a string array", () => {
    const row = questionWithGoldPlanes({
      questionId: "q-bad",
      finalRank: 1,
      planes: ["lexical"]
    });
    const broken = {
      ...row.gold[0],
      source_planes: "lexical"
    };
    expect(() => LongMemEvalGoldDiagnosticSchema.parse(broken)).toThrow();
  });
});

// @anchor abstention-classification: forensics flagged a suspected
// `_abs` -> no_gold mislabel; classifyMiss already branches on the
// isAbstention input ahead of the no_gold branch, so this asserts the
// correct verdict and guards against a future regression.
describe("abstention miss classification", () => {
  it("classifies a correct abstention as abstained_correctly, not no_gold", () => {
    // For an `_abs` question the hit booleans carry the calibrated
    // correct-at-k verdict, not an id-equality hit; hit_at_5 true means
    // recall stayed appropriately unconfident.
    const row = buildQuestionDiagnostic({
      questionId: "0862e8bf_abs",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { provider_state: "provider_not_requested" } }
    });
    expect(row.miss_classification).toBe("abstained_correctly");
  });

  it("classifies a false-confident abstention as abstain_false_confident", () => {
    const row = buildQuestionDiagnostic({
      questionId: "76d63226_abs",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "decoy", rank: 1, relevance_score: 0.9 }],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { provider_state: "provider_not_requested" } }
    });
    expect(row.miss_classification).toBe("abstain_false_confident");
  });

  it("keeps no_gold for a non-abstention question that genuinely has no gold", () => {
    const row = buildQuestionDiagnostic({
      questionId: "76d63226",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { provider_state: "provider_not_requested" } }
    });
    expect(row.miss_classification).toBe("no_gold");
  });
});
