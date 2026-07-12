import { expect, it } from "vitest";
import type { KpiPayload } from "../../schema/kpi-schema.js";
import {
  collectReleaseHardGates,
  releaseHardGateAllowsLatestPassing,
  releaseHardGateVerdict
} from "../../gates/release-gates.js";
import {
  evaluateSeedExtractionReleaseBlocker,
  isCacheOnlySeedExtractionPath
} from "../../gates/seed-extraction-blocker.js";
import {
  buildLimitedTier1Payload,
  buildLocomoPayload,
  buildPayload,
  eligibleMeasurementAttribution,
  legacyAbstention,
  makeSeedExtractionPath,
  passingQualityMetrics,
  withEligibleMeasurementContract
} from "./release-gates-fixture.js";

type LongMemBench = "public" | "public-multiturn" | "public-crossquestion";

function buildCurrentLongMemPayload(input: {
  readonly benchName: LongMemBench;
  readonly datasetName: string;
  readonly sampleSize?: number;
  readonly evaluated: number;
  readonly rAt5: number;
  readonly seedExtractionPath?: KpiPayload["kpi"]["seed_extraction_path"];
}): KpiPayload {
  const base = buildPayload("abc1234");
  return withEligibleMeasurementContract({
    ...base,
    bench_name: input.benchName,
    split: "longmemeval-s",
    dataset: { name: input.datasetName, size: 500, source: "fixture" },
    sample_size: input.sampleSize ?? input.evaluated,
    evaluated_count: input.evaluated,
    kpi: {
      ...base.kpi,
      r_at_5: input.rAt5,
      latency_ms_p95: 110,
      ...(input.seedExtractionPath === undefined
        ? {}
        : { seed_extraction_path: input.seedExtractionPath })
    }
  });
}

  it("keeps staged public coverage out of latest-passing after report gates pass", () => {
    const payload = buildCurrentLongMemPayload({
      benchName: "public",
      datasetName: "longmemeval_s",
      sampleSize: 500,
      evaluated: 100,
      rAt5: 0.72
    });

    expect(collectReleaseHardGates(payload).length).toBeGreaterThan(0);
    expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
    expect(releaseHardGateVerdict(payload)).toBe("ok");
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it.each([
    ["public" as const, "longmemeval_s"],
    ["public-multiturn" as const, "longmemeval_s:multiturn"],
    ["public-crossquestion" as const, "longmemeval_s:crossquestion"]
  ])("requires release-size coverage before %s can be latest-passing", (benchName, datasetName) => {
    const payload = buildCurrentLongMemPayload({
      benchName,
      datasetName,
      evaluated: 100,
      rAt5: 0.95
    });

    expect(releaseHardGateVerdict(payload)).toBe("ok");
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it("does not use an uncalibrated absolute candidate-absence release gate", () => {
    const current = buildReleaseGradePublic(makeSeedExtractionPath());
    const payload = {
      ...current,
      kpi: {
        ...current.kpi,
        quality_metrics: {
          ...current.kpi.quality_metrics,
          candidate_absent_count: current.evaluated_count
        }
      }
    } as KpiPayload;

    expect(collectReleaseHardGates(payload).map((gate) => gate.id))
      .not.toContain("longmemeval_s_candidate_absent");
  });

  it("reads legacy v1 attribution but rejects it at the raw release boundary", () => {
    const current = buildReleaseGradePublic(makeSeedExtractionPath());
    const legacy = {
      ...current,
      measurement_attribution: {
        schema_version: "bench-measurement-attribution.v1",
        status: "eligible",
        gate_eligible: true,
        evidence_status: "complete",
        candidate_pool_complete: true,
        provenance_complete: true,
        abstention_calibration_status: "not_applicable"
      }
    } as KpiPayload;

    expect(releaseHardGateAllowsLatestPassing(legacy)).toBe(false);
    expect(collectReleaseHardGates(legacy)).toContainEqual(
      expect.objectContaining({ id: "longmemeval_measurement_attribution", passed: false })
    );
  });

  it.each([
    ["public" as const, "longmemeval_s"],
    ["public-multiturn" as const, "longmemeval_s:multiturn"],
    ["public-crossquestion" as const, "longmemeval_s:crossquestion"]
  ])("allows release-grade %s coverage to be latest-passing", (benchName, datasetName) => {
    const payload = buildCurrentLongMemPayload({
      benchName,
      datasetName,
      evaluated: 500,
      rAt5: 0.95,
      seedExtractionPath: makeSeedExtractionPath()
    });

    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(true);
  });

  it("fails closed for legacy v1 abstention without measurement attribution", () => {
    const base = buildPayload("abc1234");
    const payload: KpiPayload = {
      ...buildLimitedTier1Payload("public", "longmemeval_s"),
      evaluated_count: 500,
      kpi: {
        ...base.kpi,
        r_at_5: 1,
        latency_ms_p95: 110,
        seed_extraction_path: makeSeedExtractionPath(),
        quality_metrics: {
          ...passingQualityMetrics(500),
          abstention: legacyAbstention()
        }
      }
    };

    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
    expect(collectReleaseHardGates(payload)).toContainEqual(
      expect.objectContaining({ id: "longmemeval_measurement_attribution", passed: false })
    );
  });

  it("rejects unsupported calibrated attribution forged at the raw gate", () => {
    const current = buildReleaseGradePublic(makeSeedExtractionPath());
    const payload = {
      ...current,
      measurement_attribution: {
        ...current.measurement_attribution,
        abstention_calibration_status: "calibrated"
      }
    } as unknown as KpiPayload;

    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it("rejects eligible not-applicable attribution forged over v1 abstention", () => {
    const current = buildReleaseGradePublic(makeSeedExtractionPath());
    const payload: KpiPayload = {
      ...current,
      kpi: {
        ...current.kpi,
        quality_metrics: {
          ...current.kpi.quality_metrics,
          abstention: legacyAbstention()
        }
      }
    };

    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it.each([
    ["missing denominator", undefined, []],
    ["missing rows", 500, []],
    ["implicit scorable", 1, [
      { id: "q-1", version: 1, hit_at_5: true, tier: "hot" as const }
    ]]
  ])("rejects eligible attribution with %s at the raw gate", (_label, answerable, rows) => {
    const payload = {
      ...buildLimitedTier1Payload("public", "longmemeval_s"),
      evaluated_count: answerable === 1 ? 1 : 500,
      answerable_evaluated_count: answerable,
      measurement_attribution: eligibleMeasurementAttribution(),
      kpi: {
        ...buildPayload("abc1234").kpi,
        seed_extraction_path: makeSeedExtractionPath(),
        per_scenario: rows,
        quality_metrics: {
          ...passingQualityMetrics(answerable === 1 ? 1 : 500),
          abstention: zeroAbstention()
        }
      }
    } as KpiPayload;

    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it.each([
    ["partial evidence", {
      evidence_status: "partial",
      candidate_pool_complete: false,
      provenance_complete: true,
      abstention_calibration_status: "not_applicable"
    }],
    ["incomplete provenance", {
      evidence_status: "complete",
      candidate_pool_complete: true,
      provenance_complete: false,
      abstention_calibration_status: "not_applicable"
    }],
    ["uncalibrated abstention", {
      evidence_status: "complete",
      candidate_pool_complete: true,
      provenance_complete: true,
      abstention_calibration_status: "uncalibrated"
    }]
  ] as const)("fails closed for %s measurement attribution", (_label, attribution) => {
    const payload = buildIneligiblePayload(attribution);
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });
  it("blocks degraded seed extraction after numeric and measurement gates pass", () => {
    const payload = buildReleaseGradePublic(makeSeedExtractionPath({
      path: "no_credentials_fallback",
      cache_hits: 0,
      offline_fallbacks: 8
    }));

    expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it("allows clean seed extraction after numeric and measurement gates pass", () => {
    const payload = buildReleaseGradePublic(makeSeedExtractionPath());
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(true);
  });

  it("blocks live extraction calls from cache-only release evidence", () => {
    const payload = buildReleaseGradePublic(makeSeedExtractionPath({ llm_calls: 1 }));

    expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it.each([
    ["llm_calls", { llm_calls: 1 }],
    ["offline_fallbacks", { offline_fallbacks: 1 }],
    ["live_extraction_failures", { live_extraction_failures: 1 }],
    ["cached_extraction_failures", { cached_extraction_failures: 1 }]
  ] as const)("rejects non-cache-only %s provenance consistently", (_field, override) => {
    const path = makeSeedExtractionPath(override);
    const payload = buildReleaseGradePublic(path);

    expect(isCacheOnlySeedExtractionPath(path)).toBe(false);
    expect(evaluateSeedExtractionReleaseBlocker(payload)).not.toBeNull();
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it.each([
    ["longmemeval_s_no_gold", { no_gold_count: 1 }],
    ["longmemeval_s_evaluator_identity_issue", { evaluator_identity_issue_count: 1 }]
  ])("fails the %s hard gate independently of candidate absence", (gateId, override) => {
    const current = buildReleaseGradePublic(makeSeedExtractionPath());
    const payload = {
      ...current,
      kpi: {
        ...current.kpi,
        quality_metrics: {
          ...current.kpi.quality_metrics,
          candidate_absent_count: 0,
          ...override
        }
      }
    } as KpiPayload;

    expect(collectReleaseHardGates(payload)).toContainEqual(
      expect.objectContaining({ id: gateId, passed: false, target: 0 })
    );
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it("blocks missing seed extraction after numeric and measurement gates pass", () => {
    const payload = buildReleaseGradePublic();
    expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it("keeps missing seed extraction backward-compatible for LoCoMo", () => {
    expect(releaseHardGateAllowsLatestPassing(buildLocomoPayload(1982, 1982, 0.56)))
      .toBe(true);
  });

  it("blocks an explicitly degraded seed path on a future non-LongMem bench", () => {
    const base = buildLocomoPayload(1982, 1982, 0.95);
    const payload: KpiPayload = {
      ...base,
      kpi: {
        ...base.kpi,
        seed_extraction_path: makeSeedExtractionPath({
          offline_fallbacks: 3,
          live_extraction_failures: 3
        })
      }
    };

    expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });
function zeroAbstention() {
  return {
    schema_version: "bench-abstention.v2" as const,
    total: 0,
    scored: 0 as const,
    unscorable: 0,
    method: "fused_margin_diagnostic_only" as const,
    calibration_status: "uncalibrated" as const,
    gate_eligible: false as const
  };
}

function buildIneligiblePayload(
  attribution: Partial<NonNullable<KpiPayload["measurement_attribution"]>>
): KpiPayload {
  return {
    ...buildLimitedTier1Payload("public", "longmemeval_s"),
    evaluated_count: 500,
    answerable_evaluated_count: 494,
    measurement_attribution: {
      ...eligibleMeasurementAttribution(),
      status: "ineligible",
      gate_eligible: false,
      ...attribution
    },
    kpi: {
      ...buildPayload("abc1234").kpi,
      seed_extraction_path: makeSeedExtractionPath(),
      per_scenario: Array.from({ length: 500 }, (_, index) => ({
        id: `question-${index + 1}`,
        version: 1,
        hit_at_5: true,
        scorable: index < 494,
        tier: "hot" as const
      })),
      quality_metrics: {
        ...passingQualityMetrics(494),
        abstention: { ...zeroAbstention(), total: 6, unscorable: 6 }
      }
    }
  };
}

function buildReleaseGradePublic(
  seedExtractionPath?: KpiPayload["kpi"]["seed_extraction_path"]
): KpiPayload {
  return buildCurrentLongMemPayload({
    benchName: "public",
    datasetName: "longmemeval_s",
    evaluated: 500,
    rAt5: 0.95,
    seedExtractionPath
  });
}
