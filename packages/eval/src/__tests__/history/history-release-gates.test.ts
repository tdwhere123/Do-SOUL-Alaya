import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffKpis } from "../../history/diff.js";
import {
  readLatest,
  writeEntry,
  type HistoryLayout
} from "../../history/history.js";
import { KpiPayloadSchema, type KpiPayload } from "../../schema/kpi-schema.js";
import { renderFindings, renderReport } from "../../reporting/report.js";
import { collectReleaseHardGates } from "../../gates/release-gates.js";
import {
  buildPayload,
  passingQualityMetrics,
  perCallStat
} from "./history-fixture.js";

describe("history archive release-gate reporting", () => {
  let layout: HistoryLayout;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "bench-history-"));
    layout = { historyRoot: root };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts public-multiturn archives and optional embedding diagnostic KPIs", async () => {
    const payload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: "public-multiturn",
      split: "longmemeval-s",
      embedding_provider: "yunwu:text-embedding-3-small",
      dataset: {
        name: "longmemeval_s:multiturn",
        size: 500,
        source: "github:xiaowu0162/LongMemEval"
      },
      sample_size: 500,
      evaluated_count: 25,
      kpi: {
        ...buildPayload("abc1234").kpi,
        r_at_5: 0.64,
        r_at_5_overall: 0.64,
        r_at_5_with_embedding_returned: 0.71,
        r_at_5_round_1: 0.52,
        r_at_5_round_2: 0.6,
        r_at_5_round_n: 0.64,
        multiturn_rounds: 3,
        provider_returned_rate: 0.8,
        provider_pending_rate: 0.12,
        provider_failed_rate: 0.08
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    expect(parsedPayload.bench_name).toBe("public-multiturn");

    const report = renderReport(parsedPayload, null, diffKpis(parsedPayload, null));
    expect(report).toContain("Public multi-turn archive");
    expect(report).toContain("Multi-turn R@5");
    expect(report).toContain("Embedding provider states");

    await writeEntry(
      layout,
      "public-multiturn",
      "2026-05-15T140000Z-abc1234",
      parsedPayload,
      report,
      null
    );
    const latest = await readLatest(layout, "public-multiturn", {
      split: "longmemeval-s"
    });
    expect(latest?.bench_name).toBe("public-multiturn");
    expect(latest?.kpi.r_at_5_with_embedding_returned).toBe(0.71);
  });

  it("flags LongMemEval-S 100 embedding-off reports below the release gate", () => {
    const payload: KpiPayload = {
      ...buildPayload("beef123"),
      bench_name: "public",
      split: "longmemeval-s",
      embedding_provider: "none",
      sample_size: 500,
      evaluated_count: 100,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "fixture"
      },
      kpi: {
        ...buildPayload("beef123").kpi,
        r_at_5: 0.68,
        latency_ms_p95: 110,
        quality_metrics: passingQualityMetrics()
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const diff = diffKpis(parsedPayload, {
      ...payload,
      alaya_commit: "c0ffee0"
    });

    const report = renderReport(parsedPayload, parsedPayload, diff);
    expect(report).toContain("Worst verdict: **FAIL**");
    expect(report).toContain("Release hard gates");
    expect(report).toContain(
      "longmemeval_s_100_embedding_off_r_at_5 LongMemEval-S 100 embedding-off R@5"
    );
    expect(report).toContain("68.00% < target 70.00%");
    expect(report).toContain("candidate_absent: 0 <= target 6");
    expect(report).toContain("recall p95 embedding-off: 110ms <= target 200ms");

    const findings = renderFindings(parsedPayload, diff);
    expect(findings).toContain("Release hard gate gaps");
    expect(findings).toContain("current 68.00% < target 70.00%");
  });

  it("renders per-recall token economy in bench reports", () => {
    const payload = KpiPayloadSchema.parse({
      ...buildPayload("beef123"),
      kpi: {
        ...buildPayload("beef123").kpi,
        recall_token_economy: {
          schema_version: "bench-recall-token-economy.v1",
          sample_count: 3,
          delivered_context_tokens_estimate: perCallStat(42),
          coarse_pool_size: perCallStat(12),
          fine_evaluated: perCallStat(12),
          fusion_streams_with_hits: perCallStat(4),
          embedding_inference_calls: perCallStat(0.333)
        }
      }
    });

    const report = renderReport(payload, null, diffKpis(payload, null));

    expect(report).toContain("Per-recall token economy (3 calls, measure-only)");
    expect(report).toContain("delivered_context_tokens");
    expect(report).toContain("embedding_inference_calls");
  });

  it("defaults legacy seed extraction failure counters and renders new failure attribution", () => {
    const legacyPayload = KpiPayloadSchema.parse({
      ...buildPayload("beef123"),
      bench_name: "public",
      split: "longmemeval-s",
      kpi: {
        ...buildPayload("beef123").kpi,
        seed_extraction_path: {
          path: "official_api_compile",
          cache_hits: 276,
          llm_calls: 0,
          offline_fallbacks: 1,
          facts_produced: 1872,
          signals_dropped: 4,
          parse_dropped: 3,
          compile_overflow_dropped: 0
        }
      }
    });
    const legacySeedExtractionPath = legacyPayload.kpi.seed_extraction_path;
    expect(legacySeedExtractionPath).toMatchObject({
      live_extraction_failures: 0,
      cached_extraction_failures: 0
    });
    if (legacySeedExtractionPath === undefined) {
      throw new Error("expected seed_extraction_path");
    }

    const attributedPayload = KpiPayloadSchema.parse({
      ...legacyPayload,
      kpi: {
        ...legacyPayload.kpi,
        seed_extraction_path: {
          ...legacySeedExtractionPath,
          live_extraction_failures: 1,
          cached_extraction_failures: 2
        }
      }
    });
    const report = renderReport(
      attributedPayload,
      null,
      diffKpis(attributedPayload, null)
    );

    expect(report).toContain("live_failures=1 cached_failures=2");
    expect(report).toContain(
      "3 turn(s) fell back after official extraction failed"
    );
    expect(report).toContain("1 live/cache-miss failure(s)");
    expect(report).toContain("2 cached raw JSON failure(s)");
  });

  it("flags LongMemEval-S embedding full reports below the release gate", () => {
    const payload: KpiPayload = {
      ...buildPayload("beef123"),
      bench_name: "public",
      split: "longmemeval-s",
      embedding_provider: "none",
      sample_size: 500,
      evaluated_count: 500,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "fixture"
      },
      kpi: {
        ...buildPayload("beef123").kpi,
        r_at_5: 0.49,
        latency_ms_p95: 900,
        quality_metrics: passingQualityMetrics()
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const diff = diffKpis(parsedPayload, {
      ...payload,
      alaya_commit: "c0ffee0"
    });

    const report = renderReport(parsedPayload, parsedPayload, diff);
    expect(report).toContain(
      "longmemeval_s_500_embedding_off_r_at_5 LongMemEval-S 500 embedding-off R@5"
    );
    expect(report).toContain("49.00% < target 90.00%");
  });

  it("fails embedding-on release gates when the provider never returns", () => {
    const payload: KpiPayload = {
      ...buildPayload("beef123"),
      bench_name: "public",
      split: "longmemeval-s",
      embedding_provider: "yunwu:text-embedding-3-small",
      sample_size: 100,
      evaluated_count: 100,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "fixture"
      },
      kpi: {
        ...buildPayload("beef123").kpi,
        r_at_5: 0.72,
        latency_ms_p95: 900,
        provider_returned_rate: 0,
        provider_pending_rate: 0,
        provider_failed_rate: 0,
        quality_metrics: passingQualityMetrics()
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const gates = collectReleaseHardGates(parsedPayload);

    expect(gates).toContainEqual(
      expect.objectContaining({
        id: "embedding_provider_returned_rate",
        current: 0,
        target: 0.95,
        passed: false
      })
    );
    expect(renderReport(parsedPayload, parsedPayload, diffKpis(parsedPayload, null))).toContain(
      "embedding_provider_returned_rate embedding provider returned"
    );
  });

  it("flags LoCoMo embedding full reports below the release gate", () => {
    const payload: KpiPayload = {
      ...buildPayload("beef123"),
      bench_name: "public-locomo",
      split: "locomo10",
      embedding_provider: "yunwu:text-embedding-3-small",
      sample_size: 1982,
      evaluated_count: 1982,
      dataset: {
        name: "locomo10",
        size: 10,
        source: "fixture"
      },
      kpi: {
        ...buildPayload("beef123").kpi,
        r_at_5: 0.39,
        latency_ms_p95: 900,
        quality_metrics: passingQualityMetrics()
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const diff = diffKpis(parsedPayload, {
      ...payload,
      alaya_commit: "c0ffee0"
    });

    const report = renderReport(parsedPayload, parsedPayload, diff);
    expect(report).toContain(
      "locomo_full_embedding_on_r_at_5 LoCoMo full embedding-on R@5"
    );
    expect(report).toContain("39.00% < target 90.00%");
  });
});
