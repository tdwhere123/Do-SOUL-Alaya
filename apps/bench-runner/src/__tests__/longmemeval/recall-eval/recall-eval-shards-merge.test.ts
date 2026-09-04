import { readFile, rm, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KpiPayload, PerScenarioRow } from "@do-soul/alaya-eval";
import type { LongMemEvalSnapshotManifest } from "../../../runs/snapshot/materialize.js";
import type { LongMemEvalWorkerShardPlan } from "../../../runs/lifecycle/recall-eval/recall-eval-shards-worker.js";
import { mergeRecallEvalShardArchives } from "../../../runs/lifecycle/recall-eval/recall-eval-shards-merge.js";
import {
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  writeShardRoot,
  makeShardKpi
} from "../../cli/merge/cli-merge-validations-fixture.js";

describe("mergeRecallEvalShardArchives — shard measurement truth", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "recall-eval-merge-truth-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("computes exact scorable R@K rates for 94 answerable + 6 abstention across uneven shards", async () => {
    const historyRoot = join(tmpRoot, "merged-history");
    const shard0Kpi = createTestShardKpi({
      offset: 0, limit: 40, abstentionIndices: [38, 39],
      hitIndices: Array.from({ length: 19 }, (_, i) => i)
    });
    const shard1Kpi = createTestShardKpi({
      offset: 40, limit: 35, abstentionIndices: [33, 34],
      hitIndices: Array.from({ length: 20 }, (_, i) => i)
    });
    const shard2Kpi = createTestShardKpi({
      offset: 75, limit: 25, abstentionIndices: [23, 24],
      hitIndices: Array.from({ length: 15 }, (_, i) => i)
    });
    const shard0Root = join(tmpRoot, "shard-0");
    const shard1Root = join(tmpRoot, "shard-1");
    const shard2Root = join(tmpRoot, "shard-2");
    await writeShardRoot(shard0Root, shard0Kpi, { questions: createTestDiagnostics(shard0Kpi) });
    await writeShardRoot(shard1Root, shard1Kpi, { questions: createTestDiagnostics(shard1Kpi) });
    await writeShardRoot(shard2Root, shard2Kpi, { questions: createTestDiagnostics(shard2Kpi) });

    const result = await mergeRecallEvalShardArchives({
      plans: [
        { shardIndex: 0, offset: 0, limit: 40, historyRoot: shard0Root },
        { shardIndex: 1, offset: 40, limit: 35, historyRoot: shard1Root },
        { shardIndex: 2, offset: 75, limit: 25, historyRoot: shard2Root }
      ],
      historyRoot,
      snapshotManifest: { question_count: 100 } as LongMemEvalSnapshotManifest,
      concurrency: 3
    });

    expect(result.payload.evaluated_count).toBe(100);
    expect(result.payload.answerable_evaluated_count).toBe(94);
    const expectedRate = 54 / 94;
    expect(result.payload.kpi.r_at_5).toBe(expectedRate);
    expect(result.payload.kpi.r_at_1).toBe(expectedRate);
    expect(result.payload.kpi.r_at_10).toBe(expectedRate);
    expect(result.payload.kpi.quality_metrics?.measurement_cohort_counts).toMatchObject({
      evaluated: 100,
      non_abstention: 94,
      abstention: 6,
      scorable_answerable: 94,
      unscorable_answerable: 0,
      hit_at_5: 54,
      miss_at_5: 40
    });
    const sources = JSON.parse(
      await readFile(join(historyRoot, "public", result.slug, "recall-eval-shard-sources.json"), "utf8")
    ) as { shards: readonly { kpi_sha256: string; shard_index: number }[] };
    expect(sources.shards).toHaveLength(3);
    expect(sources.shards.every((shard) => /^[a-f0-9]{64}$/u.test(shard.kpi_sha256))).toBe(true);
  });

  it("reconstructs exact hits from row booleans where rounded shard rates would differ", async () => {
    const historyRoot = join(tmpRoot, "exact-reconstruction");
    const shard0Root = join(tmpRoot, "shard-0");
    const shard1Root = join(tmpRoot, "shard-1");
    const shard0Kpi = createTestShardKpi({
      offset: 0, limit: 3, abstentionIndices: [], hitIndices: [0]
    });
    const shard1Kpi = createTestShardKpi({
      offset: 3, limit: 3, abstentionIndices: [], hitIndices: [0, 1]
    });
    await writeShardRoot(shard0Root, shard0Kpi, { questions: createTestDiagnostics(shard0Kpi) });
    await writeShardRoot(shard1Root, shard1Kpi, { questions: createTestDiagnostics(shard1Kpi) });

    const result = await mergeRecallEvalShardArchives({
      plans: [
        { shardIndex: 0, offset: 0, limit: 3, historyRoot: shard0Root },
        { shardIndex: 1, offset: 3, limit: 3, historyRoot: shard1Root }
      ],
      historyRoot,
      snapshotManifest: { question_count: 6 } as LongMemEvalSnapshotManifest,
      concurrency: 2
    });

    expect(result.payload.kpi.r_at_5).toBe(0.5);
    expect(result.payload.kpi.r_at_1).toBe(0.5);
    expect(result.payload.evaluated_count).toBe(6);
    expect(result.payload.answerable_evaluated_count).toBe(6);
  });

  it("fails closed on duplicate question IDs across shards", async () => {
    await expect(mergeTwoShards({
      shard0: createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [] }),
      shard1: createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [] }),
      plans: [
        { shardIndex: 0, offset: 0, limit: 2, historyRoot: join(tmpRoot, "shard-0") },
        { shardIndex: 1, offset: 2, limit: 2, historyRoot: join(tmpRoot, "shard-1") }
      ]
    })).rejects.toThrow(/duplicate question_id/u);
  });

  it("fails closed on missing diagnostic question IDs", async () => {
    const historyRoot = join(tmpRoot, "missing-id");
    const shard0Root = join(tmpRoot, "shard-0");
    const kpi = createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [] });
    await writeShardRoot(shard0Root, kpi, {
      questions: [{
        question_id: "not-in-kpi",
        hit_at_1: false,
        hit_at_5: false,
        hit_at_10: false,
        delivered_results: []
      }]
    });
    await expect(mergeRecallEvalShardArchives({
      plans: [{ shardIndex: 0, offset: 0, limit: 2, historyRoot: shard0Root }],
      historyRoot,
      snapshotManifest: { question_count: 2 } as LongMemEvalSnapshotManifest,
      concurrency: 1
    })).rejects.toThrow(/missing diagnostic for question_id/u);
  });

  it("fails closed on partition overlap between shard plans", async () => {
    await expect(mergeTwoShards({
      shard0: createTestShardKpi({ offset: 0, limit: 3, abstentionIndices: [], hitIndices: [] }),
      shard1: createTestShardKpi({ offset: 2, limit: 3, abstentionIndices: [], hitIndices: [] }),
      plans: [
        { shardIndex: 0, offset: 0, limit: 3, historyRoot: join(tmpRoot, "shard-0") },
        { shardIndex: 1, offset: 2, limit: 3, historyRoot: join(tmpRoot, "shard-1") }
      ]
    })).rejects.toThrow(/partition overlap/u);
  });

  it("fails closed on partition gap between shard plans", async () => {
    await expect(mergeTwoShards({
      shard0: createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [] }),
      shard1: createTestShardKpi({ offset: 3, limit: 2, abstentionIndices: [], hitIndices: [] }),
      plans: [
        { shardIndex: 0, offset: 0, limit: 2, historyRoot: join(tmpRoot, "shard-0") },
        { shardIndex: 1, offset: 3, limit: 2, historyRoot: join(tmpRoot, "shard-1") }
      ]
    })).rejects.toThrow(/partition gap/u);
  });

  it.each([
    ["dataset", (kpi: KpiPayload) => ({
      ...kpi, dataset: { ...kpi.dataset, name: "longmemeval_m" }
    }), /dataset mismatch/u],
    ["commit", (kpi: KpiPayload) => ({ ...kpi, alaya_commit: "zzzzzzz" }), /alaya_commit mismatch/u],
    ["arm", (kpi: KpiPayload) => ({ ...kpi, embedding_provider: "openai" }), /embedding_provider mismatch/u]
  ] as const)("fails closed on %s identity drift", async (_name, mutate, pattern) => {
    const shard0 = createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [] });
    const shard1 = mutate(
      createTestShardKpi({ offset: 2, limit: 2, abstentionIndices: [], hitIndices: [] })
    );
    await expect(mergeTwoShards({
      shard0,
      shard1,
      plans: [
        { shardIndex: 0, offset: 0, limit: 2, historyRoot: join(tmpRoot, "shard-0") },
        { shardIndex: 1, offset: 2, limit: 2, historyRoot: join(tmpRoot, "shard-1") }
      ]
    })).rejects.toThrow(pattern);
  });

  it("fails closed on missing diagnostics sidecar", async () => {
    const historyRoot = join(tmpRoot, "missing-diag");
    const shard0Root = join(tmpRoot, "shard-0");
    const kpi = createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [] });
    await writeShardRoot(shard0Root, kpi, null);
    await expect(mergeRecallEvalShardArchives({
      plans: [{ shardIndex: 0, offset: 0, limit: 2, historyRoot: shard0Root }],
      historyRoot,
      snapshotManifest: { question_count: 2 } as LongMemEvalSnapshotManifest,
      concurrency: 1
    })).rejects.toThrow(/missing diagnostics sidecar/u);
  });

  it("fails closed on corrupt diagnostics sidecar", async () => {
    const historyRoot = join(tmpRoot, "corrupt-diag");
    const shard0Root = join(tmpRoot, "shard-0");
    const kpi = createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [] });
    await writeShardRoot(shard0Root, kpi, { questions: createTestDiagnostics(kpi) });
    const slug = "2026-05-14T100000Z-" + kpi.alaya_commit;
    await writeFile(
      join(shard0Root, "public", slug, LONGMEMEVAL_DIAGNOSTICS_FILENAME),
      "{not-json",
      "utf8"
    );
    await expect(mergeRecallEvalShardArchives({
      plans: [{ shardIndex: 0, offset: 0, limit: 2, historyRoot: shard0Root }],
      historyRoot,
      snapshotManifest: { question_count: 2 } as LongMemEvalSnapshotManifest,
      concurrency: 1
    })).rejects.toThrow(/corrupt diagnostics/u);
  });

  it("fails closed when a row is not explicitly bound to a scorable cohort", async () => {
    const historyRoot = join(tmpRoot, "unbound-cohort");
    const shard0Root = join(tmpRoot, "shard-0");
    const kpi = createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [] });
    const unbound: KpiPayload = {
      ...kpi,
      kpi: {
        ...kpi.kpi,
        per_scenario: kpi.kpi.per_scenario.map((row, index) => index === 0
          ? { id: row.id, version: 1, hit_at_5: row.hit_at_5, tier: "warm" as const }
          : row)
      }
    };
    await writeShardRoot(shard0Root, unbound, { questions: createTestDiagnostics(unbound) });
    await expect(mergeRecallEvalShardArchives({
      plans: [{ shardIndex: 0, offset: 0, limit: 2, historyRoot: shard0Root }],
      historyRoot,
      snapshotManifest: { question_count: 2 } as LongMemEvalSnapshotManifest,
      concurrency: 1
    })).rejects.toThrow(/not explicitly bound to a scorable cohort/u);
  });

  it("forces inherited child gate_eligible=true to diagnostic-only false and does not mutate latest pointers", async () => {
    const historyRoot = join(tmpRoot, "non-promotable");
    const shard0Root = join(tmpRoot, "shard-0");
    const shard0Kpi = {
      ...createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [0] }),
      recall_eval_attribution: {
        status: "attributed" as const,
        gate_eligible: true,
        node_version: "v24.0.0",
        platform: "linux",
        arch: "x64",
        embedding_mode: "disabled" as const,
        embedding_provider_kind: "openai" as const,
        embedding_provider_label: "none",
        onnx_threads: null,
        onnx_model_artifact_sha256: null,
        evaluation_slice: {
          evaluated_count: 2,
          question_id_digest: "a".repeat(64),
          offset: 0,
          limit: 2
        },
        snapshot_binding: {
          commit_sha7: null,
          gate_sha256: null,
          worktree_state_sha256: null,
          extraction_cache_manifest_sha256: null,
          extraction_cache_requested_turns: null,
          extraction_cache_cached_turns: null,
          extraction_cache_coverage: null,
          dataset_sha256: null,
          question_id_digest: null
        }
      },
      measurement_attribution: {
        schema_version: "bench-measurement-attribution.v3" as const,
        gate_eligible: true,
        status: "eligible" as const,
        evidence_status: "complete" as const,
        candidate_pool_complete: true,
        provenance_complete: true,
        measurement_scope: "answerable_recall" as const,
        abstention_evaluation_status: "excluded_not_evaluated" as const,
        abstention_calibration_status: "uncalibrated" as const,
        abstention_gate_eligible: false as const,
        abstention_evidence_status: "current_uncalibrated" as const,
        evaluator_identity_status: "complete" as const
      }
    };
    await writeShardRoot(shard0Root, shard0Kpi, { questions: createTestDiagnostics(shard0Kpi) });

    const result = await mergeRecallEvalShardArchives({
      plans: [{ shardIndex: 0, offset: 0, limit: 2, historyRoot: shard0Root }],
      historyRoot,
      snapshotManifest: { question_count: 2 } as LongMemEvalSnapshotManifest,
      concurrency: 1
    });

    expect(result.payload.recall_eval_attribution?.gate_eligible).toBe(false);
    expect(result.payload.measurement_attribution?.gate_eligible).toBe(false);
    expect(result.payload.measurement_attribution?.status).toBe("ineligible");
    expect(result.payload.recall_eval_attribution?.evaluation_slice?.evaluated_count).toBe(2);
    await expect(readFile(join(historyRoot, "public", "latest-run.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(historyRoot, "public", "latest-passing.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("omits unrecomputable shard-zero aggregates instead of inheriting them", async () => {
    const historyRoot = join(tmpRoot, "stale-fields");
    const shard0Root = join(tmpRoot, "shard-0");
    const shard1Root = join(tmpRoot, "shard-1");
    const shard0Base = createTestShardKpi({
      offset: 0, limit: 2, abstentionIndices: [], hitIndices: [0]
    });
    const shard1Kpi = createTestShardKpi({
      offset: 2, limit: 2, abstentionIndices: [], hitIndices: []
    });
    const shard0Kpi: KpiPayload = {
      ...shard0Base,
      kpi: {
        ...shard0Base.kpi,
        token_saved_ratio_vs_full_prompt: 0.99,
        provider_returned_rate: 0.42,
        r_at_5_with_embedding_returned: 0.87,
        quality_metrics: {
          ...shard0Base.kpi.quality_metrics!,
          non_monotonic_count: 99,
          non_monotonic_rate: 0.5
        }
      }
    };
    await writeShardRoot(shard0Root, shard0Kpi, { questions: createTestDiagnostics(shard0Kpi) });
    await writeShardRoot(shard1Root, shard1Kpi, { questions: createTestDiagnostics(shard1Kpi) });

    const result = await mergeRecallEvalShardArchives({
      plans: [
        { shardIndex: 0, offset: 0, limit: 2, historyRoot: shard0Root },
        { shardIndex: 1, offset: 2, limit: 2, historyRoot: shard1Root }
      ],
      historyRoot,
      snapshotManifest: { question_count: 4 } as LongMemEvalSnapshotManifest,
      concurrency: 2
    });

    expect(result.payload.kpi.provider_returned_rate).toBeUndefined();
    expect(result.payload.kpi.r_at_5_with_embedding_returned).toBeUndefined();
    expect(result.payload.kpi.token_economy).toBeUndefined();
    expect(result.payload.kpi.qa_metrics).toBeUndefined();
    expect(result.payload.kpi.full_gold_coverage).toBeUndefined();
    expect(result.payload.kpi).not.toHaveProperty("token_saved_ratio_vs_full_prompt");
    const written = JSON.parse(
      await readFile(join(historyRoot, "public", result.slug, "kpi.json"), "utf8")
    ) as { kpi: Record<string, unknown> };
    expect(written.kpi).not.toHaveProperty("token_saved_ratio_vs_full_prompt");
    expect(result.payload.kpi.quality_metrics?.non_monotonic_count).not.toBe(99);
    expect(result.payload.selection_contract).toBeUndefined();
  });

  it("treats all-unavailable rank identity as absent, not observed-empty delivery", async () => {
    const historyRoot = join(tmpRoot, "rank-absent");
    const shard0Root = join(tmpRoot, "shard-0");
    const kpi = createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [0] });
    await writeShardRoot(shard0Root, kpi, { questions: createTestDiagnostics(kpi) });

    const result = await mergeRecallEvalShardArchives({
      plans: [{ shardIndex: 0, offset: 0, limit: 2, historyRoot: shard0Root }],
      historyRoot,
      snapshotManifest: { question_count: 2 } as LongMemEvalSnapshotManifest,
      concurrency: 1
    });

    await expect(
      readFile(join(historyRoot, "public", result.slug, "recall-eval-rank-identity.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.perQuestionDelivered.get("q-1")).toEqual(["mem-q-1"]);
    expect(result.perQuestionDelivered.get("q-2")).toEqual(["mem-q-2"]);
  });

  it("fails closed when rank identity sidecars are present but empty", async () => {
    const historyRoot = join(tmpRoot, "rank-empty");
    const shard0Root = join(tmpRoot, "shard-0");
    const kpi = createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [] });
    await writeShardRoot(shard0Root, kpi, { questions: createTestDiagnostics(kpi) });
    const slug = "2026-05-14T100000Z-" + kpi.alaya_commit;
    await writeFile(
      join(shard0Root, "public", slug, "recall-eval-rank-identity.json"),
      JSON.stringify({ schema_version: 2, questions: [] }),
      "utf8"
    );
    await expect(mergeRecallEvalShardArchives({
      plans: [{ shardIndex: 0, offset: 0, limit: 2, historyRoot: shard0Root }],
      historyRoot,
      snapshotManifest: { question_count: 2 } as LongMemEvalSnapshotManifest,
      concurrency: 1
    })).rejects.toThrow(/rank identity present but empty/u);
  });

  it("fails closed when only some shards have rank identity", async () => {
    const historyRoot = join(tmpRoot, "rank-mixed");
    const shard0Root = join(tmpRoot, "shard-0");
    const shard1Root = join(tmpRoot, "shard-1");
    const shard0 = createTestShardKpi({ offset: 0, limit: 2, abstentionIndices: [], hitIndices: [] });
    const shard1 = createTestShardKpi({ offset: 2, limit: 2, abstentionIndices: [], hitIndices: [] });
    await writeShardRoot(shard0Root, shard0, { questions: createTestDiagnostics(shard0) });
    await writeShardRoot(shard1Root, shard1, { questions: createTestDiagnostics(shard1) });
    const slug = "2026-05-14T100000Z-" + shard0.alaya_commit;
    await writeFile(
      join(shard0Root, "public", slug, "recall-eval-rank-identity.json"),
      JSON.stringify({
        schema_version: 2,
        questions: shard0.kpi.per_scenario.map((row) => ({
          question_id: row.id,
          delivered_objects: [`mem-${row.id}`]
        }))
      }),
      "utf8"
    );
    await expect(mergeRecallEvalShardArchives({
      plans: [
        { shardIndex: 0, offset: 0, limit: 2, historyRoot: shard0Root },
        { shardIndex: 1, offset: 2, limit: 2, historyRoot: shard1Root }
      ],
      historyRoot,
      snapshotManifest: { question_count: 4 } as LongMemEvalSnapshotManifest,
      concurrency: 2
    })).rejects.toThrow(/rank identity sidecar missing from some shards/u);
  });
});

async function mergeTwoShards(input: {
  readonly shard0: KpiPayload;
  readonly shard1: KpiPayload;
  readonly plans: readonly LongMemEvalWorkerShardPlan[];
}): Promise<unknown> {
  const historyRoot = join(input.plans[0]!.historyRoot, "..", "merged-history");
  await mkdir(historyRoot, { recursive: true });
  await writeShardRoot(input.plans[0]!.historyRoot, input.shard0, {
    questions: createTestDiagnostics(input.shard0)
  });
  await writeShardRoot(input.plans[1]!.historyRoot, input.shard1, {
    questions: createTestDiagnostics(input.shard1)
  });
  return mergeRecallEvalShardArchives({
    plans: input.plans,
    historyRoot,
    snapshotManifest: { question_count: 4 } as LongMemEvalSnapshotManifest,
    concurrency: 2
  });
}

function createTestShardKpi(opts: {
  offset: number;
  limit: number;
  abstentionIndices: readonly number[];
  hitIndices: readonly number[];
}): KpiPayload {
  const rows: PerScenarioRow[] = Array.from({ length: opts.limit }, (_, index) => {
    const isAbstention = opts.abstentionIndices.includes(index);
    const isHit = opts.hitIndices.includes(index);
    return {
      id: `q-${opts.offset + index + 1}`,
      version: 1,
      hit_at_5: isHit,
      latency_ms: 10 + index,
      scorable: !isAbstention,
      measurement_cohort: isAbstention ? "dataset_declared_abstention" : "answerable",
      tier: "warm"
    };
  });
  const base = makeShardKpi();
  const answerableCount = rows.filter((row) => row.scorable === true).length;
  const hitCount = rows.filter((row) => row.scorable === true && row.hit_at_5).length;
  const rate = answerableCount === 0 ? 0 : hitCount / answerableCount;
  return {
    ...base,
    evaluated_count: opts.limit,
    answerable_evaluated_count: answerableCount,
    kpi: {
      ...base.kpi,
      per_scenario: rows,
      r_at_1: rate,
      r_at_5: rate,
      r_at_10: rate
    }
  };
}

function createTestDiagnostics(payload: KpiPayload): Record<string, unknown>[] {
  return payload.kpi.per_scenario.map((row) => ({
    question_id: row.id,
    hit_at_1: row.hit_at_5,
    hit_at_5: row.hit_at_5,
    hit_at_10: row.hit_at_5,
    scorable: row.scorable,
    measurement_cohort: row.measurement_cohort,
    delivered_results: [{ object_id: `mem-${row.id}` }]
  }));
}
