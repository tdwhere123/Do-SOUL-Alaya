import { describe, expect, it } from "vitest";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../longmemeval/diagnostics/schema/diagnostics-schema.js";
import { verifyPromotionGoldEvidence } from
  "../../../longmemeval/promotion/verifiers/gold-verifier.js";
import { promotionMeasurementDiagnostic } from
  "../recall-eval/specialized-answerable-recall-fixture.js";

describe("promotion evidence gold", () => {
  it("recomputes EvidenceCapsule hits from kind-aware snapshot gold", () => {
    const question = evidenceGoldDiagnostic();

    expect(verifyPromotionGoldEvidence({
      question,
      expectedGoldIdentities: [{
        objectId: "q-evidence-gold",
        objectKind: "evidence_capsule"
      }],
      scorable: true
    })).toEqual({ hitAt1: true, hitAt5: true, hitAt10: true });
  });

  it("does not let a same-id MemoryEntry impersonate evidence gold", () => {
    const evidence = evidenceGoldDiagnostic();
    const question = LongMemEvalQuestionDiagnosticSchema.parse({
      ...evidence,
      delivered_results: evidence.delivered_results.map((row) => ({
        ...row,
        object_kind: "memory_entry"
      })),
      candidates: evidence.candidates.map((row) => ({
        ...row,
        object_kind: "memory_entry",
        candidate_key: `workspace_local:memory_entry:${row.object_id}`
      }))
    });

    expect(() => verifyPromotionGoldEvidence({
      question,
      expectedGoldIdentities: [{
        objectId: "q-evidence-gold",
        objectKind: "evidence_capsule"
      }],
      scorable: true
    })).toThrow(/gold diagnostics differ|hit@k differs/u);
  });

  it("keeps the legacy memory-only verifier contract", () => {
    const question = promotionMeasurementDiagnostic("q-legacy", "scorable", true);

    expect(verifyPromotionGoldEvidence({
      question,
      expectedGold: question.gold_memory_ids,
      scorable: true
    }).hitAt5).toBe(true);
  });
});

function evidenceGoldDiagnostic() {
  const base = promotionMeasurementDiagnostic("q-evidence", "scorable", true);
  const { quality_axes: _qualityAxes, ...baseWithoutAxes } = base;
  const {
    quality_axes: _ledgerQualityAxes,
    ...ledgerWithoutAxes
  } = base.cohort_ledger!;
  const objectId = base.gold_memory_ids[0]!;
  const gold = base.gold.map((row) => ({
    ...row,
    object_kind: "evidence_capsule" as const
  }));
  return LongMemEvalQuestionDiagnosticSchema.parse({
    ...baseWithoutAxes,
    gold_memory_ids: [],
    gold_evidence_ids: [objectId],
    gold_object_ids: [objectId],
    delivered_results: base.delivered_results.map((row) => ({
      ...row,
      object_kind: "evidence_capsule"
    })),
    candidates: base.candidates.map((row) => ({
      ...row,
      object_kind: "evidence_capsule",
      candidate_key: `workspace_local:evidence_capsule:${row.object_id}`
    })),
    gold,
    cohort_ledger: {
      ...ledgerWithoutAxes,
      extraction_materialization: {
        status: "evidence_preserved",
        emitted_memory_count: 0,
        reason: null
      },
      evaluator_gold_identity: {
        status: "present",
        object_ids: [objectId]
      },
      stage_ranks: gold.map((row) => ({
        object_id: row.object_id,
        object_kind: row.object_kind,
        fused_rank: row.fused_rank,
        rank_after_feature_rerank: row.rank_after_feature_rerank,
        rank_after_lexical_priority: row.rank_after_lexical_priority,
        rank_after_synthesis_reserve: row.rank_after_synthesis_reserve,
        rank_after_structural_reserve: row.rank_after_structural_reserve,
        rank_after_coverage_selector: row.rank_after_coverage_selector,
        rank_after_session_coverage: row.rank_after_session_coverage,
        selection_order: row.selection_order,
        final_rank: row.final_rank
      }))
    }
  });
}
