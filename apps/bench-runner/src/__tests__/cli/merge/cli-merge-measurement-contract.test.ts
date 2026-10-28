import { describe, expect, it } from "vitest";
import {
  diffKpis,
  buildTokenEconomy,
  KpiPayloadSchema,
  renderReport,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { buildMergedLongMemEvalPayload } from "../../../cli/merge/command/merge-command-shards.js";
import { mergeQualityMetrics } from "../../../cli/merge/quality/merge-quality.js";
import {
  makeQualityMetrics,
  makeShardKpi,
  withEligibleMeasurementContract
} from "./cli-merge-validations-fixture.js";

describe("merge LongMemEval measurement contract", () => {
  it("uses the same diagnostic denominator for legacy merged rates, report confidence, and regression bands", () => {
    const base = makeShardKpi();
    const legacy = makeShardKpi({ evaluated_count: 3, kpi: { ...base.kpi, per_scenario: [
      { id: "legacy-hit", version: 1, hit_at_1: true, hit_at_5: true, hit_at_10: true, tier: "warm" },
      { id: "legacy-miss", version: 1, hit_at_1: false, hit_at_5: false, hit_at_10: false, tier: "warm" },
      { id: "legacy_abs", version: 1, hit_at_1: false, hit_at_5: false, hit_at_10: false, tier: "warm" }
    ] } });
    const payload = buildMergedLongMemEvalPayload({ payloads: [legacy], first: legacy, archiveRefs: [], questionDiagnostics: [] }).payload;
    expect(payload).toMatchObject({ evaluated_count: 3, reporting_recall_denominator: 2 });
    expect(payload.answerable_evaluated_count).toBeUndefined();
    expect(payload.kpi.r_at_5).toBe(0.5);
    const previous = { ...payload, kpi: { ...payload.kpi, r_at_5: 0.89 } };
    const diff = diffKpis(payload, previous);
    expect(diff.deltas.find((delta) => delta.key === "r_at_5")?.verdict).toBe("ok");
    expect(renderReport(payload, previous, diff)).toContain("[9.45%, 90.55%]");
  });
  it("conserves mixed evaluated, non-abstention, scorable and hit cohorts", () => {
    const payloads = ["a", "b"].map((prefix) => {
      const base = shard(prefix, 3, 1);
      return {
        ...base,
        answerable_evaluated_count: 2,
        measurement_attribution: { ...base.measurement_attribution!, evaluator_identity_status: "invalid" as const },
        kpi: {
          ...base.kpi,
          r_at_1: 0.5, r_at_5: 0.5, r_at_10: 0.5,
          quality_metrics: {
            ...base.kpi.quality_metrics!,
            ...makeQualityMetrics({ denominator: 2, candidateAbsent: 1 }),
            evaluator_identity_issue_count: 1,
            evaluator_identity_issue_denominator: 3,
            evaluator_identity_unscorable_count: 1,
            evaluator_identity_unscorable_denominator: 3,
            measurement_cohort_counts: { evaluated: 4, non_abstention: 3, abstention: 1,
              scorable_answerable: 2, unscorable_answerable: 1, hit_at_5: 1, miss_at_5: 1 },
            unscorable_reason_distribution: { evaluator_identity_unscorable: 1, abstention_uncalibrated: 1 }
          },
          per_scenario: base.kpi.per_scenario.map((row, index) => ({ ...row,
            scorable: index < 2, hit_at_1: index === 0, hit_at_5: index === 0, hit_at_10: index === 0 }))
        }
      };
    });
    const merged = buildMergedLongMemEvalPayload({ payloads, first: payloads[0]!,
      archiveRefs: [], questionDiagnostics: [] }).payload;
    expect(KpiPayloadSchema.parse(merged)).toMatchObject({ evaluated_count: 8, answerable_evaluated_count: 4,
      kpi: { r_at_5: 0.5, quality_metrics: { measurement_cohort_counts: {
        evaluated: 8, non_abstention: 6, abstention: 2, scorable_answerable: 4,
        unscorable_answerable: 2, hit_at_5: 2, miss_at_5: 2
      }, unscorable_reason_distribution: { evaluator_identity_unscorable: 2, abstention_uncalibrated: 2 } } } });
  });

  it.each([false, true])("preserves unknown token savings with incomplete shard evidence (first known: %s)", (firstKnown) => {
    const first = shard("a", 1, 0);
    const payloads = [{ ...first, kpi: { ...first.kpi,
      ...(firstKnown ? { token_economy: buildTokenEconomy({ raw_history_tokens: 100,
        stored_memory_tokens: 20, recalled_context_tokens_total: 10, recall_event_count: 1,
        recalled_context_tokens_mean: 10, seed_event_count: 1 }), token_saved_ratio_vs_full_prompt: 0.9 } : {})
    } }, shard("b", 1, 0)];
    const merged = buildMergedLongMemEvalPayload({ payloads, first: payloads[0]!,
      archiveRefs: [], questionDiagnostics: [] }).payload;
    expect(merged.kpi.token_saved_ratio_vs_full_prompt).toBeNull();
    expect(merged.kpi.token_economy).toBeUndefined();
    expect(renderReport(merged, null, diffKpis(merged, null))).toContain("unavailable");
  });

  it("preserves the 94 answerable plus 6 uncalibrated abstention contract", () => {
    const payloads = [shard("a", 47, 3), shard("b", 47, 3)];
    const build = buildMergedLongMemEvalPayload({
      payloads,
      archiveRefs: [],
      questionDiagnostics: [],
      first: payloads[0]!
    });

    expect(build.payload).toMatchObject({
      evaluated_count: 100,
      answerable_evaluated_count: 94,
      kpi: {
        quality_metrics: {
          abstention: {
            schema_version: "bench-abstention.v2",
            total: 6,
            scored: 0,
            unscorable: 6,
            gate_eligible: false
          },
          measurement_cohort_counts: {
            evaluated: 100,
            non_abstention: 94,
            abstention: 6,
            scorable_answerable: 94,
            unscorable_answerable: 0,
            hit_at_5: 94,
            miss_at_5: 0
          },
          unscorable_reason_distribution: {
            abstention_uncalibrated: 6
          }
        }
      }
    });
    expect(KpiPayloadSchema.parse(build.payload)).toMatchObject({
      evaluated_count: 100,
      answerable_evaluated_count: 94
    });
    const report = renderReport(build.payload, null, diffKpis(build.payload, null));
    expect(report).toContain("Recall metric denominator: 94 answerable/scorable questions");
    expect(report).toContain("Abstention (uncalibrated, diagnostic-only): 6 questions");
    expect(report).toContain("| scorable | tier |");
    expect(report).toContain("| N/A | no | warm |");
  });

  it("rejects mixed or missing abstention contracts", () => {
    const current = shard("current", 47, 3);
    const missing = withAbstention(current, undefined);
    const legacy = withAbstention(current, legacyAbstention());

    expect(() => mergeQualityMetrics([current, missing])).toThrow(/abstention.*missing/u);
    expect(() => mergeQualityMetrics([current, legacy])).toThrow(/abstention.*schema/u);
  });

  it("rejects partially present measurement accounting", () => {
    const current = shard("current", 47, 3);
    const quality = current.kpi.quality_metrics!;
    const {
      measurement_cohort_counts: _cohorts,
      unscorable_reason_distribution: _reasons,
      ...legacyQuality
    } = quality;
    const legacy = {
      ...current,
      kpi: { ...current.kpi, quality_metrics: legacyQuality }
    };

    expect(() => mergeQualityMetrics([current, legacy])).toThrow(
      /measurement accounting.*missing/u
    );
  });

  it("rejects merged measurement accounting whose reasons do not conserve", () => {
    const current = shard("current", 47, 3);
    const inconsistent = {
      ...current,
      kpi: {
        ...current.kpi,
        quality_metrics: {
          ...current.kpi.quality_metrics!,
          unscorable_reason_distribution: { abstention_uncalibrated: 2 }
        }
      }
    };

    expect(() => buildMergedLongMemEvalPayload({
      payloads: [inconsistent],
      archiveRefs: [],
      questionDiagnostics: [],
      first: inconsistent
    })).toThrow(/unscorable reason.*conservation/u);
  });

  it("rejects all-v1 abstention shards instead of relabeling them as v2", () => {
    const legacy = withAbstention(shard("legacy", 47, 3), legacyAbstention());

    expect(() => mergeQualityMetrics([legacy, legacy])).toThrow(/legacy|v1/u);
  });

  it("rejects a shard with missing quality metrics in a measured merge", () => {
    const current = shard("current", 47, 3);
    const missing = {
      ...current,
      kpi: { ...current.kpi, quality_metrics: undefined }
    };

    expect(() => mergeQualityMetrics([current, missing])).toThrow(/quality metrics.*missing/u);
  });

  it("rejects v2 abstention evidence without the rest of the current contract", () => {
    const current = shard("current", 47, 3);
    const { answerable_evaluated_count: _answerable, ...missingDenominator } = current;

    expect(() => mergeQualityMetrics([missingDenominator as KpiPayload]))
      .toThrow(/measurement contract.*missing/u);
  });

  it("rejects a shard whose answerable count disagrees with scorable rows", () => {
    const inconsistent = {
      ...shard("bad", 47, 3),
      answerable_evaluated_count: 46
    };

    expect(() => buildMergedLongMemEvalPayload({
      payloads: [inconsistent],
      archiveRefs: [],
      questionDiagnostics: [],
      first: inconsistent
    })).toThrow(/answerable_evaluated_count.*scorable/u);
  });

  it("counts merged R@K hits from scenario row booleans instead of rounded shard rates", () => {
    const legacy = makeShardKpi({
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi,
        r_at_1: 0,
        r_at_5: 0,
        r_at_10: 0,
        r_at_5_overall: 0,
        per_scenario: [
          {
            id: "legacy-hit",
            version: 1,
            hit_at_5: true,
            hit_at_1: true,
            hit_at_10: true,
            tier: "warm"
          }
        ]
      }
    });

    const build = buildMergedLongMemEvalPayload({
      payloads: [legacy],
      archiveRefs: [],
      questionDiagnostics: [],
      first: legacy
    });
    expect(build.payload.kpi.r_at_1).toBe(0.2);
    expect(build.payload.kpi.r_at_5).toBe(0.2);
    expect(build.payload.kpi.r_at_10).toBe(0.2);
    expect(build.payload.kpi.r_at_5_overall).toBe(0.2);
    expect(build.payload.answerable_evaluated_count).toBeUndefined();
  });

  it("fails closed when R@1/R@10 cannot be recomputed from row or diagnostic booleans", () => {
    const bound = withEligibleMeasurementContract(makeShardKpi({
      evaluated_count: 1,
      kpi: {
        ...makeShardKpi().kpi,
        r_at_1: 1,
        r_at_5: 1,
        r_at_10: 1,
        per_scenario: [
          {
            id: "question-1",
            version: 1,
            hit_at_5: true,
            scorable: true,
            measurement_cohort: "answerable",
            tier: "warm"
          }
        ]
      }
    }));
    const missingHits = {
      ...bound,
      kpi: {
        ...bound.kpi,
        per_scenario: [
          {
            id: "question-1",
            version: 1,
            hit_at_5: true,
            scorable: true,
            measurement_cohort: "answerable" as const,
            tier: "warm" as const
          }
        ]
      }
    };
    expect(() => buildMergedLongMemEvalPayload({
      payloads: [missingHits],
      archiveRefs: [],
      questionDiagnostics: [],
      first: missingHits
    })).toThrow(/missing hit_at_1 boolean/u);
  });
});

function shard(prefix: string, answerable: number, abstention: number): KpiPayload {
  const evaluated = answerable + abstention;
  const base = makeShardKpi();
  return makeShardKpi({
    evaluated_count: evaluated,
    answerable_evaluated_count: answerable,
    measurement_attribution: {
      schema_version: "bench-measurement-attribution.v3",
      status: "ineligible",
      gate_eligible: false,
      evidence_status: "complete",
      candidate_pool_complete: true,
      provenance_complete: true,
      measurement_scope: "answerable_recall",
      abstention_evaluation_status: "excluded_not_evaluated",
      abstention_calibration_status: "uncalibrated",
      abstention_gate_eligible: false,
      abstention_evidence_status: "current_uncalibrated",
      evaluator_identity_status: "complete"
    },
    kpi: {
      ...base.kpi,
      r_at_5: answerable === 0 ? 0 : 1,
      quality_metrics: {
        ...makeQualityMetrics({ denominator: answerable }),
        abstention: currentAbstention(abstention),
        measurement_cohort_counts: {
          evaluated,
          non_abstention: answerable,
          abstention,
          scorable_answerable: answerable,
          unscorable_answerable: 0,
          hit_at_5: answerable,
          miss_at_5: 0
        },
        unscorable_reason_distribution: abstention === 0
          ? {}
          : { abstention_uncalibrated: abstention }
      },
      per_scenario: Array.from({ length: evaluated }, (_, index) => ({
        id: `${prefix}-${index}`,
        version: 1,
        hit_at_5: index < answerable,
        hit_at_1: index < answerable,
        hit_at_10: index < answerable,
        scorable: index < answerable,
        measurement_cohort: index < answerable
          ? "answerable" as const
          : "dataset_declared_abstention" as const,
        tier: "warm" as const,
        latency_ms: 1
      }))
    }
  });
}

function withAbstention(
  payload: KpiPayload,
  abstention: NonNullable<KpiPayload["kpi"]["quality_metrics"]>["abstention"]
): KpiPayload {
  return {
    ...payload,
    kpi: {
      ...payload.kpi,
      quality_metrics: {
        ...payload.kpi.quality_metrics!,
        abstention
      }
    }
  };
}

function currentAbstention(total: number) {
  return {
    schema_version: "bench-abstention.v2" as const,
    total,
    scored: 0 as const,
    unscorable: total,
    method: "fused_margin_diagnostic_only" as const,
    calibration_status: "uncalibrated" as const,
    gate_eligible: false as const
  };
}

function legacyAbstention() {
  return {
    schema_version: "bench-abstention.v1" as const,
    total: 3,
    false_confident_threshold: 0.91,
    correct_at_1: 1,
    correct_at_5: 1,
    correct_at_10: 1,
    false_confident_at_1: 2,
    false_confident_at_5: 2,
    false_confident_at_10: 2
  };
}
