import { describe, expect, it } from "vitest";
import {
  diffKpis,
  KpiPayloadSchema,
  renderReport,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { buildMergedLongMemEvalPayload } from "../../cli/merge-command-shards.js";
import { mergeQualityMetrics } from "../../cli/merge-quality.js";
import {
  makeQualityMetrics,
  makeShardKpi
} from "./cli-merge-validations-fixture.js";

describe("merge LongMemEval measurement contract", () => {
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

  it("counts merged R@5 hits from scenario rows instead of rounded shard rates", () => {
    const legacy = makeShardKpi({
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi,
        r_at_5: 0,
        per_scenario: [
          { id: "legacy-hit", version: 1, hit_at_5: true, tier: "warm" }
        ]
      }
    });

    const build = buildMergedLongMemEvalPayload({
      payloads: [legacy],
      archiveRefs: [],
      questionDiagnostics: [],
      first: legacy
    });
    expect(build.payload.kpi.r_at_5).toBe(0.2);
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
