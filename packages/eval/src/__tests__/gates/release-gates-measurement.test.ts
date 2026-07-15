import { expect, it } from "vitest";
import type { KpiPayload } from "../../schema/kpi-schema.js";
import {
  collectReleaseHardGates,
  releaseHardGateAllowsLatestPassing,
  releaseMetricGateVerdict
} from "../../gates/release-gates.js";
import {
  buildLimitedTier1Payload,
  buildLocomoPayload,
  buildPayload,
  buildReleaseGradePublic,
  eligibleMeasurementAttribution,
  legacyAbstention,
  makeSeedExtractionPath,
  passingQualityMetrics,
  withEligibleMeasurementContract
} from "./release-gates-fixture.js";
import { verifiedEvidenceForPayload } from "./verified-evidence-fixture.js";

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

function perCallStat(value: number) {
  return { mean: value, p50: value, p95: value, max: value };
}

function withEmbeddingActivation(
  payload: KpiPayload,
  inferenceCallsMean?: number,
  sampleCount = payload.evaluated_count
): KpiPayload {
  return {
    ...payload,
    embedding_provider: "local_onnx:Xenova/all-MiniLM-L6-v2",
    kpi: {
      ...payload.kpi,
      provider_returned_rate: 1,
      ...(inferenceCallsMean === undefined
        ? {}
        : {
            recall_token_economy: {
              schema_version: "bench-recall-token-economy.v1",
              sample_count: sampleCount,
              delivered_context_tokens_estimate: perCallStat(42),
              coarse_pool_size: perCallStat(12),
              fine_evaluated: perCallStat(8),
              fine_pruned_count: perCallStat(4),
              fusion_families_with_hits: perCallStat(3),
              embedding_inference_calls: perCallStat(inferenceCallsMean)
            }
          })
    }
  };
}

it.each([
  [100, 0.899, false],
  [100, 0.9, true],
  [500, 0.899, false],
  [500, 0.9, true]
] as const)(
  "holds LongMemEval-S %i embedding-on R@5 at the 0.90 boundary",
  (sampleSize, rAt5, passed) => {
    const measured = buildCurrentLongMemPayload({
      benchName: "public",
      datasetName: "longmemeval_s",
      evaluated: sampleSize,
      rAt5: 0.9
    });
    // A 100-row hit ratio cannot encode 0.899, so isolate the numeric gate
    // after constructing a schema-valid measurement payload.
    const payload = withEmbeddingActivation({
      ...measured,
      kpi: { ...measured.kpi, r_at_5: rAt5 }
    }, 1);
    const gate = collectReleaseHardGates(payload).find(
      (candidate) => candidate.id ===
        `longmemeval_s_${sampleSize}_embedding_on_r_at_5`
    );

    expect(gate).toMatchObject({ current: rAt5, target: 0.9, passed });
  }
);

it.each([
  [undefined, null, false],
  [0, 0, false],
  [0.999, 0.999, false],
  [1, 1, true]
] as const)(
  "requires LongMemEval-S embedding inference mean %s to reach one",
  async (mean, current, passed) => {
    const payload = withEmbeddingActivation(buildCurrentLongMemPayload({
      benchName: "public",
      datasetName: "longmemeval_s",
      evaluated: 500,
      rAt5: 0.95,
      seedExtractionPath: makeSeedExtractionPath()
    }), mean);
    const gate = collectReleaseHardGates(payload).find(
      (candidate) => candidate.id ===
        "longmemeval_s_embedding_inference_calls_mean"
    );

    expect(gate).toMatchObject({ current, target: 1, passed, missing: mean === undefined });
    expect(releaseHardGateAllowsLatestPassing(
      payload,
      passed ? await verifiedEvidenceForPayload(payload) : undefined
    )).toBe(passed);
  }
);

it("fails closed when embedding inference telemetry omits a recall", () => {
  const payload = withEmbeddingActivation(buildCurrentLongMemPayload({
    benchName: "public",
    datasetName: "longmemeval_s",
    evaluated: 500,
    rAt5: 0.95,
    seedExtractionPath: makeSeedExtractionPath()
  }), 1, 499);
  const gate = collectReleaseHardGates(payload).find(
    (candidate) => candidate.id ===
      "longmemeval_s_embedding_inference_calls_mean"
  );

  expect(gate).toMatchObject({ current: null, passed: false, missing: true });
  expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
});

it("does not apply the embedding inference activation gate outside embedding-on LongMemEval-S", () => {
  const embeddingOff = buildCurrentLongMemPayload({
    benchName: "public",
    datasetName: "longmemeval_s",
    evaluated: 100,
    rAt5: 0.95
  });
  const locomo = withEmbeddingActivation(buildLocomoPayload(1982, 1982, 0.95), 0);

  for (const payload of [embeddingOff, locomo]) {
    expect(collectReleaseHardGates(payload).map((gate) => gate.id))
      .not.toContain("longmemeval_s_embedding_inference_calls_mean");
  }
});

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
    expect(releaseMetricGateVerdict(payload)).toBe("ok");
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

    expect(releaseMetricGateVerdict(payload)).toBe("ok");
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

  it("does not let a self-consistent plain KPI payload mint release evidence", () => {
    const forged = buildReleaseGradePublic(makeSeedExtractionPath());
    expect(forged.selection_contract?.expected_cohort_counts).toEqual({
      answerable: 500,
      abstention: 0
    });

    expect(releaseHardGateAllowsLatestPassing(forged)).toBe(false);
  });

  it.each([
    ["public" as const, "longmemeval_s"],
    ["public-multiturn" as const, "longmemeval_s:multiturn"],
    ["public-crossquestion" as const, "longmemeval_s:crossquestion"]
  ])("rejects self-consistent %s coverage when external selection is missing", (
    benchName,
    datasetName
  ) => {
    const payload = buildCurrentLongMemPayload({
      benchName,
      datasetName,
      evaluated: 500,
      rAt5: 0.95,
      seedExtractionPath: makeSeedExtractionPath()
    });
    const withoutExternalSelection = { ...payload, selection_contract: undefined };

    expect(releaseHardGateAllowsLatestPassing(withoutExternalSelection)).toBe(false);
  });

  it.each([
    ["dataset SHA", (payload: KpiPayload) => ({
      ...payload,
      selection_contract: { ...payload.selection_contract!, dataset_sha256: "e".repeat(64) }
    })],
    ["selected count", (payload: KpiPayload) => ({
      ...payload,
      selection_contract: { ...payload.selection_contract!, selected_count: 499 }
    })],
    ["ordered ID digest", (payload: KpiPayload) => ({
      ...payload,
      selection_contract: { ...payload.selection_contract!, selected_id_digest: "e".repeat(64) }
    })],
    ["expected cohorts", (payload: KpiPayload) => ({
      ...payload,
      selection_contract: {
        ...payload.selection_contract!,
        expected_cohort_counts: { answerable: 499, abstention: 1 }
      }
    })],
    ["ordered assignment digest", (payload: KpiPayload) => ({
      ...payload,
      selection_contract: {
        ...payload.selection_contract!,
        cohort_assignment_digest: "e".repeat(64)
      }
    })],
    ["observed row ordering", (payload: KpiPayload) => ({
      ...payload,
      kpi: { ...payload.kpi, per_scenario: [...payload.kpi.per_scenario].reverse() }
    })]
  ])("rejects external selection %s drift at the raw gate", (_label, forge) => {
    const payload = buildCurrentLongMemPayload({
      benchName: "public",
      datasetName: "longmemeval_s",
      evaluated: 500,
      rAt5: 0.95,
      seedExtractionPath: makeSeedExtractionPath()
    });

    expect(releaseHardGateAllowsLatestPassing(forge(payload))).toBe(false);
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
          ...current.kpi.quality_metrics!,
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
    } as NonNullable<KpiPayload["measurement_attribution"]>,
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
