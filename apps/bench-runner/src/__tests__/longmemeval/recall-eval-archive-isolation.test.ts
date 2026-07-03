import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  entrySlug,
  writeEntry,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  RECALL_EVAL_ARCHIVE_MARKER,
  isRecallEvalArchive,
  selectFullRunBaseline
} from "../../longmemeval/recall-eval-archive.js";

// @anchor recall-eval-archive-isolation — I3: a fast-loop recall-eval archive
// shares the public/ bench + (split, policy, simulate, provider) bucket with
// full runs, but never paid extraction/materialization. It must carry an
// explicit discriminator and must never be selected as a full-run baseline.
// cross-file: apps/bench-runner/src/longmemeval/recall-eval-archive.ts

function passingQualityMetrics(): NonNullable<KpiPayload["kpi"]["quality_metrics"]> {
  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: 0,
    non_monotonic_count: 0,
    non_monotonic_denominator: 100,
    budget_drop_distribution: {
      max_entries: { count: 0, share: 0, denominator: 100 }
    },
    high_lexical_demoted_rate: 0,
    high_lexical_demoted_count: 0,
    high_lexical_demoted_denominator: 0,
    candidate_absent_count: 0,
    candidate_absent_denominator: 100,
    no_gold_count: 0,
    no_gold_denominator: 100,
    evidence_stream_gold_delivery_rate: 0.2,
    evidence_stream_gold_delivery_count: 20,
    evidence_stream_gold_delivery_denominator: 100,
    path_stream_top10_rate: 0.12,
    path_stream_top10_count: 12,
    path_stream_top10_denominator: 100,
    per_plane_recall_coverage: {},
    miss_taxonomy_distribution: {
      candidate_absent: 0,
      materialization_drop: 0,
      budget_drop: 0,
      delivery_order_drop: 0,
      evaluation_or_gold_issue: 0
    },
    miss_distribution: {}
  };
}

function cleanSeedExtractionPath(): NonNullable<KpiPayload["kpi"]["seed_extraction_path"]> {
  return {
    path: "official_api_compile",
    cache_hits: 276,
    llm_calls: 0,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: 1872,
    signals_dropped: 4,
    parse_dropped: 3,
    compile_overflow_dropped: 0,
    signals_dropped_by_reason: { candidate_absent: 1, materialization_drop: 0 }
  };
}

function buildPublicPayload(input: {
  readonly commit: string;
  readonly rAt5: number;
  readonly recallEval: boolean;
}): KpiPayload {
  return {
    bench_name: "public",
    split: "longmemeval-oracle",
    run_at: "2026-05-20T10:00:00.000Z",
    alaya_commit: input.commit,
    alaya_version: "0.3.11",
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: {
      name: "longmemeval_oracle",
      size: 500,
      source: "fixture",
      checksum_sha256: input.recallEval ? "snapshot-inherited" : "abc123",
      // The marker is the parse-surviving discriminator for fast-loop archives.
      checksum_source: input.recallEval
        ? `${RECALL_EVAL_ARCHIVE_MARKER} snapshot.db`
        : "pinned longmemeval_oracle.meta.json"
    },
    sample_size: 500,
    evaluated_count: 500,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0.6,
      r_at_5: input.rAt5,
      r_at_10: 0.9,
      latency_ms_p50: 60,
      latency_ms_p95: 110,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0.88,
      tier_distribution: { hot: 50, warm: 30, cold: 20 },
      degradation_reasons: {
        none: 80,
        warm_cascade_engaged: 12,
        cold_cascade_engaged: 8,
        recall_explainability_partial: 0
      },
      quality_metrics: passingQualityMetrics(),
      seed_extraction_path: cleanSeedExtractionPath(),
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: []
    }
  };
}

let historyRoot: string;
let layout: HistoryLayout;

beforeEach(async () => {
  historyRoot = await mkdtemp(join(tmpdir(), "recall-eval-isolation-"));
  layout = { historyRoot };
});

afterEach(async () => {
  await rm(historyRoot, { recursive: true, force: true });
});

describe("recall-eval archive discriminator + baseline isolation", () => {
  it("marks a recall-eval archive and leaves a full run unmarked", () => {
    const fullRun = buildPublicPayload({ commit: "f".repeat(7), rAt5: 0.8, recallEval: false });
    const recallEval = buildPublicPayload({ commit: "e".repeat(7), rAt5: 0.5, recallEval: true });
    expect(isRecallEvalArchive(fullRun)).toBe(false);
    expect(isRecallEvalArchive(recallEval)).toBe(true);
    expect(recallEval.dataset.checksum_source?.startsWith(RECALL_EVAL_ARCHIVE_MARKER)).toBe(true);
  });

  it("never selects a recall-eval archive as a full-run baseline, even when it is the newest passing entry", async () => {
    // An OLDER full-run baseline (passing).
    const fullRun = buildPublicPayload({ commit: "f".repeat(7), rAt5: 0.8, recallEval: false });
    const fullRunSlug = entrySlug(new Date("2026-05-20T10:00:00.000Z"), "f".repeat(7), "policy-stress");
    await writeEntry(layout, "public", fullRunSlug, fullRun, "# report\n", null);

    // A NEWER recall-eval archive in the SAME bucket (also passing). Without
    // the marker filter, readLatest(passing) would return THIS one.
    const recallEval = buildPublicPayload({ commit: "e".repeat(7), rAt5: 0.5, recallEval: true });
    const recallEvalSlug = entrySlug(
      new Date("2026-05-21T10:00:00.000Z"),
      "e".repeat(7),
      `policy-stress-${RECALL_EVAL_ARCHIVE_MARKER}`
    );
    await writeEntry(layout, "public", recallEvalSlug, recallEval, "# report\n", null);

    const baseline = await selectFullRunBaseline(layout, "public", {
      split: "longmemeval-oracle",
      policyShape: "stress",
      simulateReport: "none",
      embeddingProvider: "none"
    });

    expect(baseline).not.toBeNull();
    expect(isRecallEvalArchive(baseline!)).toBe(false);
    expect(baseline!.alaya_commit).toBe("f".repeat(7));
    expect(baseline!.kpi.r_at_5).toBe(0.8);
  });

  it("returns null when the only passing entry in the bucket is a recall-eval archive", async () => {
    const recallEval = buildPublicPayload({ commit: "e".repeat(7), rAt5: 0.5, recallEval: true });
    const recallEvalSlug = entrySlug(
      new Date("2026-05-21T10:00:00.000Z"),
      "e".repeat(7),
      `policy-stress-${RECALL_EVAL_ARCHIVE_MARKER}`
    );
    await writeEntry(layout, "public", recallEvalSlug, recallEval, "# report\n", null);

    const baseline = await selectFullRunBaseline(layout, "public", {
      split: "longmemeval-oracle",
      policyShape: "stress",
      simulateReport: "none",
      embeddingProvider: "none"
    });
    expect(baseline).toBeNull();
  });
});
