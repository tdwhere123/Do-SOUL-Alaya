// @ts-nocheck
import { describe, expect, it } from "vitest";
import { buildStageAttributionTables } from
  "../../../diagnostics/stage-attribution/index.js";
import { baseQuestion } from "./stage-attribution-fixture.js";
import {
  assembledQuestion,
  cohortOnlyQuestion,
  flagOnlyQuestion
} from "./abstention-diagnostic-fixture.js";

describe("stage attribution abstention exclusion", () => {
  it("keeps historical measurement identity unknown alongside current scorable rows", () => {
    const current = baseQuestion({ question_id: "current", gold_memory_ids: ["gold"] });
    const { cohort_ledger: _ledger, ...legacy } = current;
    const synthesized = { ...current, question_id: "synthesized", cohort_ledger: {
      ...current.cohort_ledger, measurement_evidence_mode: "legacy_synthesized" } };
    const tables = buildStageAttributionTables({ cell: "fixture", sourceDiagnostics: "fixture",
      questions: [current, { ...legacy, question_id: "legacy" }, synthesized] });
    expect(tables.questions.map((row) => row.question_id)).toEqual(["current"]);
    expect(tables.summary).toMatchObject({ measurement_unknown_question_ids: ["legacy", "synthesized"],
      denominators: { D_Q_evaluated: 3, D_Q_non_abstention: 3, D_Q_scorable: 1,
        D_Q_unscorable: 0, D_Q_measurement_unknown: 2 } });
  });
  it("does not change scorable stage membership when a live _abs twin is present", () => {
    const answerable = [
      baseQuestion({
        question_id: "0862e8bf",
        hit_at_5: true,
        miss_classification: "hit_at_5",
        gold_memory_ids: ["g1"]
      }),
      baseQuestion({
        question_id: "58bf7951",
        miss_classification: "under_ranked",
        gold_memory_ids: ["g2"]
      })
    ];
    const withoutAbs = buildStageAttributionTables({
      cell: "fixture", sourceDiagnostics: "fixture", questions: answerable
    });
    const withAbs = buildStageAttributionTables({
      cell: "fixture",
      sourceDiagnostics: "fixture",
      questions: [
        ...answerable,
        baseQuestion({
          question_id: "0862e8bf_abs",
          is_abstention: true,
          miss_classification: "abstention"
        })
      ]
    });

    expect(withAbs.summary.denominators.D_Q_evaluated).toBe(
      withoutAbs.summary.denominators.D_Q_evaluated + 1
    );
    expect(withAbs.summary.denominators.D_Q_scorable)
      .toEqual(withoutAbs.summary.denominators.D_Q_scorable);
    expect(withAbs.questions.map((row) => row.question_id))
      .toEqual(withoutAbs.questions.map((row) => row.question_id));
    expect(withAbs.summary.question_stage_counts)
      .toEqual(withoutAbs.summary.question_stage_counts);
  });

  it("skips flag-only and cohort-only rows that lack an _abs suffix", () => {
    const answerable = [
      baseQuestion({
        question_id: "0862e8bf",
        hit_at_5: true,
        miss_classification: "hit_at_5",
        gold_memory_ids: ["g1"]
      })
    ];
    const flagOnly = flagOnlyQuestion("58bf7951");
    const cohortOnly = cohortOnlyQuestion("7c1d9e20");
    expect(flagOnly.question_id.endsWith("_abs")).toBe(false);
    expect(cohortOnly.question_id.endsWith("_abs")).toBe(false);

    const tables = buildStageAttributionTables({
      cell: "fixture",
      sourceDiagnostics: "fixture",
      questions: [...answerable, flagOnly, cohortOnly]
    });
    expect(tables.questions.map((row) => row.question_id)).toEqual(["0862e8bf"]);
    expect(tables.summary.denominators.D_Q_evaluated).toBe(3);
    expect(tables.summary.denominators.D_Q_scorable).toBe(1);
  });

  it("retains an empty-gold answerable as unscorable rather than a retrieval miss", () => {
    const ordinary = assembledQuestion({ questionId: "58bf7951" });
    const tables = buildStageAttributionTables({
      cell: "fixture", sourceDiagnostics: "fixture", questions: [ordinary]
    });
    expect(tables.questions).toEqual([]);
    expect(tables.summary.denominators).toMatchObject({ D_Q_evaluated: 1,
      D_Q_non_abstention: 1, D_Q_unscorable: 1, D_Q_scorable: 0, D_Q_miss: 0 });
  });
});
