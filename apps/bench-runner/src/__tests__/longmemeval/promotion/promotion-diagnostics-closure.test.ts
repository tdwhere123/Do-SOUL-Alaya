import { afterEach, describe, expect, it } from "vitest";
import type { LongMemEvalQuestionDiagnostic } from "../../../longmemeval/diagnostics/schema/diagnostics-types.js";
import { RecallEvalRankIdentitySchema } from "../../../longmemeval/promotion/schema/evidence-schema.js";
import { verifyPromotionGoldEvidence } from "../../../longmemeval/promotion/verifiers/gold-verifier.js";
import { promotionMeasurementDiagnostic } from
  "../recall-eval/specialized-answerable-recall-fixture.js";
import {
  cleanupPromotionDiagnosticsFixtureRoots,
  fixtureEvidence,
  verifyFixture,
  type MeasurementOracle,
  type MutableQuestion
} from "./promotion-diagnostics-fixture.js";

afterEach(cleanupPromotionDiagnosticsFixtureRoots);

describe("promotion-grade recall-eval diagnostics verification", () => {
  it.each([
    ["inconsistent", (oracle: MeasurementOracle) => ({
      ...oracle,
      sidecar: oracle.sidecar.map((entry) => ({ ...entry, hasAnswer: false }))
    })],
    ["indeterminate", (oracle: MeasurementOracle) => ({
      ...oracle,
      answer: "",
      sidecar: []
    })]
  ] as const)(
    "rejects producer-consistent evaluator identity that canonical primitives make %s",
    async (_status, mutate) => {
      const fixture = fixtureEvidence();
      const measurement = new Map(fixture.measurementByQuestion);
      measurement.set("q-1", mutate(measurement.get("q-1")!));

      await expect(verifyFixture(
        fixture.payload,
        fixture.diagnostics,
        fixture.rank,
        fixture.goldByQuestion,
        measurement
      )).rejects.toThrow(/measurement axes|evaluator identity/iu);
    }
  );

  it("rejects a synthesis capsule that collides with a memory-entry gold ID", async () => {
    const fixture = fixtureEvidence();
    const parsed = JSON.parse(fixture.diagnostics) as {
      questions: Array<{
        diagnostics: { delivered_results: Array<{ object_kind?: string }> };
      }>;
    };
    parsed.questions[0]!.diagnostics.delivered_results[0]!.object_kind =
      "synthesis_capsule";
    const rank = RecallEvalRankIdentitySchema.parse({
      ...fixture.rank,
      questions: fixture.rank.questions.map((row, index) => index === 0
        ? {
            ...row,
            delivered_objects: row.delivered_objects.map((object) => ({
              ...object,
              object_kind: "synthesis_capsule"
            }))
          }
        : row)
    });

    await expect(verifyFixture(
      fixture.payload,
      JSON.stringify(parsed),
      rank,
      fixture.goldByQuestion
    )).rejects.toThrow(/delivered candidate binding/u);
  });

  it("rejects self-consistent diagnostics gold that differs from the snapshot", async () => {
    const fixture = fixtureEvidence();
    const parsed = JSON.parse(fixture.diagnostics) as {
      questions: Array<{
        diagnostics: {
          gold_memory_ids: string[];
          gold: Array<{ object_id: string }>;
          cohort_ledger: {
            evaluator_gold_identity: { object_ids: string[] };
            stage_ranks: Array<{ object_id: string }>;
          };
        };
      }>;
    };
    const question = parsed.questions[0]!.diagnostics;
    question.gold_memory_ids = ["forged-gold"];
    question.cohort_ledger.evaluator_gold_identity.object_ids = ["forged-gold"];
    question.gold[0]!.object_id = "forged-gold";
    question.cohort_ledger.stage_ranks[0]!.object_id = "forged-gold";

    await expect(verifyFixture(
      fixture.payload,
      JSON.stringify(parsed),
      fixture.rank,
      fixture.goldByQuestion
    )).rejects.toThrow(/gold identity differs from snapshot/u);
  });

  it.each([
    ["final rank", (question: MutableQuestion) => {
      question.diagnostics.gold[0]!.final_rank = 2;
      question.diagnostics.cohort_ledger.stage_ranks[0]!.final_rank = 2;
    }, /gold diagnostics/u],
    ["budget drop", (question: MutableQuestion) => {
      question.diagnostics.gold[0]!.budget_drop_reason = "max_entries";
      question.diagnostics.miss_classification = "budget_dropped";
    }, /gold diagnostics/u],
    ["score factors", (question: MutableQuestion) => {
      question.diagnostics.gold[0]!.score_factors = { forged: 1 };
    }, /gold diagnostics/u],
    ["stage ranks", (question: MutableQuestion) => {
      question.diagnostics.cohort_ledger.stage_ranks[0]!.selection_order = 99;
    }, /stage ranks/u],
    ["gold miss taxonomy", (question: MutableQuestion) => {
      question.diagnostics.gold[0]!.miss_taxonomy = "candidate_absent";
    }, /gold miss taxonomy/u],
    ["question miss taxonomy", (question: MutableQuestion) => {
      question.diagnostics.miss_taxonomy = "candidate_absent";
    }, /question miss taxonomy/u],
    ["delivered display rank", (question: MutableQuestion) => {
      question.diagnostics.delivered_results[0]!.rank = 2;
    }, /delivered rank/u],
    ["missing delivered candidate", (question: MutableQuestion) => {
      question.diagnostics.candidates = [];
      question.diagnostics.candidate_pool_count = 0;
    }, /delivered candidate binding/u],
    ["candidate final-rank mismatch", (question: MutableQuestion) => {
      question.diagnostics.candidates[0]!.final_rank = 2;
    }, /delivered candidate binding/u],
    ["orphan candidate final rank", (question: MutableQuestion) => {
      question.diagnostics.candidates.push({
        ...question.diagnostics.candidates[0]!,
        object_id: "orphan",
        candidate_key: "workspace_local:memory_entry:orphan",
        final_rank: 2
      });
      question.diagnostics.candidate_pool_count += 1;
    }, /candidate delivery binding/u],
    ["duplicate candidate key", (question: MutableQuestion) => {
      question.diagnostics.candidates.push({
        ...question.diagnostics.candidates[0]!,
        object_id: "other",
        final_rank: null
      });
      question.diagnostics.candidate_key_collisions = [];
    }, /repeats candidate/u],
    ["duplicate candidate kind and id", (question: MutableQuestion) => {
      question.diagnostics.candidates.push({
        ...question.diagnostics.candidates[0]!,
        candidate_key: "duplicate-kind-id",
        final_rank: null
      });
      question.diagnostics.candidate_key_collisions = [];
    }, /repeats candidate/u],
    ["candidate budget-drop reason", (question: MutableQuestion) => {
      question.diagnostics.candidates[0]!.budget_drop_reason = "unknown_reason";
    }, /failed v2 schema/u],
    ["gold budget-drop reason", (question: MutableQuestion) => {
      question.diagnostics.gold[0]!.budget_drop_reason = "unknown_reason";
    }, /failed v2 schema/u],
  ] as const)("rejects forged gold %s", async (_label, mutate, error) => {
    const fixture = fixtureEvidence();
    const parsed = JSON.parse(fixture.diagnostics) as { questions: MutableQuestion[] };
    mutate(parsed.questions[0]!);

    await expect(verifyFixture(
      fixture.payload,
      JSON.stringify(parsed),
      fixture.rank,
      fixture.goldByQuestion
    )).rejects.toThrow(error);
  });

  it("accepts cross-kind candidates that share an object id", async () => {
    const fixture = fixtureEvidence();
    const parsed = JSON.parse(fixture.diagnostics) as { questions: MutableQuestion[] };
    const question = parsed.questions[0]!;
    question.diagnostics.candidates.push({
      ...question.diagnostics.candidates[0]!,
      object_kind: "synthesis_capsule",
      candidate_key: "workspace_local:synthesis_capsule:q-1-gold",
      final_rank: null
    });
    question.diagnostics.candidate_pool_count += 1;
    question.diagnostics.candidate_key_collisions = [];

    await expect(verifyFixture(
      fixture.payload,
      JSON.stringify(parsed),
      fixture.rank,
      fixture.goldByQuestion
    )).resolves.toBeDefined();
  });

  it.each([
    ["status", (diagnostics: MutableQuestion["diagnostics"]) => {
      diagnostics.cohort_ledger.evaluator_gold_identity.status = "absent";
    }],
    ["evaluation issue", (diagnostics: MutableQuestion["diagnostics"]) => {
      diagnostics.cohort_ledger.evaluation_issue_reason = "empty_gold_identity";
    }]
  ] as const)("binds evaluator gold %s to snapshot truth", (_label, mutate) => {
    const diagnostics = structuredClone(
      promotionMeasurementDiagnostic("q-direct", "scorable", true)
    ) as unknown as MutableQuestion["diagnostics"];
    mutate(diagnostics);

    expect(() => verifyPromotionGoldEvidence({
      question: diagnostics as unknown as LongMemEvalQuestionDiagnostic,
      expectedGold: ["q-direct-gold"],
      scorable: true
    })).toThrow(/gold identity differs from snapshot/u);
  });

  it.each([
    [false, true],
    [true, false]
  ] as const)(
    "rejects is_abstention=%s when the KPI cohort expects %s",
    async (mixedCohort, forged) => {
      const fixture = fixtureEvidence(mixedCohort);
      const parsed = JSON.parse(fixture.diagnostics) as { questions: MutableQuestion[] };
      parsed.questions[mixedCohort ? 1 : 0]!.diagnostics.is_abstention = forged;

      await expect(verifyFixture(
        fixture.payload,
        JSON.stringify(parsed),
        fixture.rank,
        fixture.goldByQuestion
      )).rejects.toThrow(/KPI row differs/u);
    }
  );
});
