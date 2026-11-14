import { gunzipSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { KpiPayloadSchema, renderReport, diffKpis } from "@do-soul/alaya-eval";
import { access, appendFile, mkdtemp, readFile, rm, stat, truncate } from
  "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeRecallEvalShardArchives } from "../../../runs/lifecycle/recall-eval/recall-eval-shards-merge.js";
import { writeShardRoot } from "../../cli/merge/cli-merge-validations-fixture.js";
import { assembleRecallEvalKpi } from
  "../../../runs/kpi/recall-eval-payload.js";
import type { RecallEvalQuestionResult } from
  "../../../runs/lifecycle/recall-eval/recall-eval-contract.js";
import {
  buildRecallEvalDiagnosticsEvidence,
  writeRecallEvalDiagnosticsGzipStream
} from
  "../../../runs/provenance/recall-eval/recall-eval-diagnostics.js";
import {
  RecallEvalDiagnosticsSpool,
  withRecallEvalDiagnosticsSpool
} from
  "../../../runs/provenance/recall-eval/recall-eval-diagnostics-spool.js";
import { renderRecallEvalRankIdentity } from
  "../../../runs/provenance/recall-eval/recall-eval-rank-identity.js";
import {
  emptyTokenMetrics,
  promotionMeasurementDiagnostic
} from "./specialized-answerable-recall-fixture.js";

const roots: string[] = [];
const disabledRuntime = {
  embeddingSupplement: { enabled: false } as const,
  answerRerank: { enabled: false } as const
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("recall evaluator cohort persistence", () => {
  it("carries production scorable, abstention and identity-unscorable rows through shard merge and schema readback", async () => {
    const root = await mkdtemp(join(tmpdir(), "producer-cohort-merge-")); roots.push(root);
    const collected = (["scorable", "abstention", "identity_unscorable"] as const).map((status, index) => {
      const id = `cohort-${index}`, hit = status === "scorable";
      const diagnostics = promotionMeasurementDiagnostic(id, status, hit);
      return { ...question(id), diagnostics, hitAt1: hit, hitAt5: hit, hitAt10: hit,
        deliveredObjectIds: diagnostics.delivered_results.flatMap(row => row.object_id === undefined ? [] : [row.object_id]) };
    });
    const payload = assembleRecallEvalKpi(kpiInput(collected));
    const source = KpiPayloadSchema.parse(JSON.parse(JSON.stringify(payload)));
    expect(source.kpi.quality_metrics?.evaluator_identity_unscorable_denominator).toBe(3);
    const shardRoot = join(root, "shard");
    await writeShardRoot(shardRoot, source, { questions: collected.map(row => row.diagnostics) });
    const result = await mergeRecallEvalShardArchives({
      plans: [{ shardIndex: 0, offset: 0, limit: 3, historyRoot: shardRoot }],
      historyRoot: join(root, "merged"), snapshotManifest: kpiInput(collected).manifest, concurrency: 1
    });
    const persisted = KpiPayloadSchema.parse(JSON.parse(await readFile(result.kpiPath, "utf8")));
    expect(persisted).toMatchObject({ evaluated_count: 3, answerable_evaluated_count: 1,
      kpi: { r_at_5: 1, quality_metrics: { schema_version: "bench-quality-metrics.unavailable.v1",
        evaluator_identity_unscorable_count: 1, evaluator_identity_unscorable_denominator: 3,
        measurement_cohort_counts: { evaluated: 3, non_abstention: 2, abstention: 1,
          scorable_answerable: 1, unscorable_answerable: 1, hit_at_5: 1, miss_at_5: 0 } } } });
    expect(persisted.measurement_attribution?.gate_eligible).toBe(false);
  });
});

describe("worker-shard provider state persistence", () => {
  const states = ["provider_returned", "provider_pending", "provider_failed", "provider_not_requested",
    "query_embedding_unusable", "unknown"] as const;
  const fields = ["provider_returned_rate", "provider_pending_rate", "provider_failed_rate",
    "provider_not_requested_rate", "query_embedding_unusable_rate", "provider_unknown_rate"] as const;
  it.each([
    { name: "all unknown", indexes: [5, 5, 5], counts: [0, 0, 0, 0, 0, 3], historical: false },
    { name: "all measured states", indexes: [0, 1, 2, 3, 4, 5, 5], counts: [1, 1, 1, 1, 1, 2], historical: false },
    { name: "disabled", indexes: [3, 3, 3], counts: [0, 0, 0, 3, 0, 0], historical: false },
    { name: "historical missing sibling", indexes: [5, 0, 0], counts: [2, 0, 0, 0, 0, 1], historical: true }
  ])("conserves declared provider populations from producer through persisted worker-shard merge: $name", async fixture => {
    const root = await mkdtemp(join(tmpdir(), "provider-shard-merge-")); roots.push(root);
    const rows = fixture.indexes.map((state, index) => {
      const row = question(`provider-${index}`);
      return { ...row, diagnostics: { ...row.diagnostics, provider_state: states[state]! } };
    });
    const groups = [rows.slice(0, 1), rows.slice(1)], plans = [];
    for (const [shardIndex, group] of groups.entries()) {
      const input = { ...kpiInput(group), sampleSize: rows.length };
      const produced = assembleRecallEvalKpi(input);
      if (fixture.historical && shardIndex === 1) for (const field of fields) delete produced.kpi[field];
      const shardRoot = join(root, `shard-${shardIndex}`);
      await writeShardRoot(shardRoot, produced, { questions: group.map(row => row.diagnostics) });
      plans.push({ shardIndex, offset: shardIndex === 0 ? 0 : 1, limit: group.length, historyRoot: shardRoot });
    }
    const result = await mergeRecallEvalShardArchives({ plans, historyRoot: join(root, "merged"),
      snapshotManifest: kpiInput(rows).manifest, concurrency: 2 });
    const persisted = KpiPayloadSchema.parse(JSON.parse(await readFile(result.kpiPath, "utf8")));
    expect(persisted.evaluated_count).toBe(rows.length);
    for (const [index, field] of fields.entries()) {
      if (fixture.historical) expect(persisted.kpi).not.toHaveProperty(field);
      else expect(persisted.kpi[field]).toBe(fixture.counts[index]! / rows.length);
    }
    if (!fixture.historical) expect(fields.reduce((sum, field) => sum + persisted.kpi[field]!, 0)).toBeCloseTo(1);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Strictly non-promotable diagnostic evidence: gate_eligible=false.");
    if (fixture.historical) expect(report).not.toContain("Embedding provider states:");
    else for (const [index, label] of ["returned", "pending", "failed", "not_requested", "unusable", "unknown"].entries()) {
      expect(report).toContain(`${label}=${(fixture.counts[index]! / rows.length * 100).toFixed(2)}%`);
    }
    expect(persisted.kpi.quality_metrics).toMatchObject({ schema_version: "bench-quality-metrics.unavailable.v1",
      unavailable_reason: "not_recomputed_from_shard_archives" });
    expect(persisted.kpi.quality_metrics).not.toHaveProperty("non_monotonic_rate");
    expect(persisted.measurement_attribution?.gate_eligible).toBe(false);
  });
});

describe("provider state KPI persistence", () => {
  it.each([
    { states: ["unknown", "unknown"], unknown: 1, returned: 0 },
    { states: ["unknown", "provider_returned"], unknown: 0.5, returned: 0.5 },
    { states: ["provider_not_requested", "provider_not_requested"], unknown: 0, returned: 0 }
  ] as const)("keeps unknown in the whole evaluated denominator: %j", async fixture => {
    const rows = fixture.states.map((state, index) => {
      const row = question(`state-${index}`);
      return { ...row, diagnostics: { ...row.diagnostics, provider_state: state } };
    });
    const payload = assembleRecallEvalKpi(kpiInput(rows));
    const root = await mkdtemp(join(tmpdir(), "provider-kpi-")); roots.push(root);
    await writeFile(join(root, "kpi.json"), JSON.stringify(payload));
    const persisted = KpiPayloadSchema.parse(JSON.parse(await readFile(join(root, "kpi.json"), "utf8")));
    expect(persisted.evaluated_count).toBe(2);
    expect(persisted.kpi.provider_unknown_rate).toBe(fixture.unknown);
    expect(persisted.kpi.provider_returned_rate).toBe(fixture.returned);
    expect(renderReport(persisted, null, diffKpis(persisted, null)))
      .toContain(`unknown=${(fixture.unknown * 100).toFixed(2)}%`);
    const historical = structuredClone(payload);
    delete historical.kpi.provider_unknown_rate;
    const legacy = KpiPayloadSchema.parse(JSON.parse(JSON.stringify(historical)));
    expect(legacy.kpi).not.toHaveProperty("provider_unknown_rate");
    expect(renderReport(legacy, null, diffKpis(legacy, null))).toContain("unknown=n/a");
  });
});

describe("RecallEvalDiagnosticsSpool", () => {
  it("spools full rows while retaining KPI- and rank-identical compact rows", async () => {
    const full = [question("q-1"), question("q-2")];
    const spool = await RecallEvalDiagnosticsSpool.create();
    const retained = await Promise.all(full.map((row) => spool.append(row)));

    expect(retained.every((row) => row.diagnostics.candidates.length === 0)).toBe(true);
    expect(retained.every((row) => row.diagnostics.query_probes != null)).toBe(true);
    expect(assembleRecallEvalKpi(kpiInput(retained))).toEqual(
      assembleRecallEvalKpi(kpiInput(full))
    );
    expect(renderRank(retained)).toBe(renderRank(full));

    await spool.dispose();
  });
});

describe("RecallEvalDiagnosticsSpool artifact parity", () => {
  it("streams the current diagnostics schema with full rows in original order", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "recall-eval-spool-output-"));
    roots.push(outputRoot);
    const full = [question("q-1"), question("q-2")];
    const spool = await RecallEvalDiagnosticsSpool.create();
    const retained = await Promise.all(full.map((row) => spool.append(row)));
    const artifactPath = join(outputRoot, "recall-eval-diagnostics.json.gz");
    const baselinePath = join(outputRoot, "baseline.json.gz");

    await spool.writeGzipArtifact(artifactPath, {
      retainedQuestions: retained,
      ...disabledRuntime
    });

    await writeRecallEvalDiagnosticsGzipStream(
      baselinePath,
      buildRecallEvalDiagnosticsEvidence({ questions: full, ...disabledRuntime })
    );
    const decompressed = gunzipSync(await readFile(artifactPath)).toString("utf8");
    expect(decompressed).toBe(
      gunzipSync(await readFile(baselinePath)).toString("utf8")
    );
    const parsed = JSON.parse(decompressed) as {
      questions: Array<{ question_id: string; diagnostics: {
        candidates: unknown[];
        query_probes?: { normalized_query?: string } | null;
      } }>;
    };
    expect(parsed.questions.map((row) => row.question_id)).toEqual(["q-1", "q-2"]);
    expect(parsed.questions[0]?.diagnostics.candidates).toHaveLength(1);
    expect(parsed.questions[0]?.diagnostics.query_probes?.normalized_query)
      .toBe("x".repeat(1_024));
    await expect(spool.append(question("q-after-seal"))).rejects.toThrow(/sealed/u);
    await spool.dispose();
  });
});

describe("RecallEvalDiagnosticsSpool concurrent ordering", () => {
  it("serializes concurrent appends in invocation order", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "recall-eval-spool-order-"));
    roots.push(outputRoot);
    const spool = await RecallEvalDiagnosticsSpool.create();
    const full = Array.from({ length: 20 }, (_, index) =>
      question(`q-${index}-${"x".repeat(index * 17)}`));
    const retained = await Promise.all(full.map((row) => spool.append(row)));
    const artifactPath = join(outputRoot, "ordered.json.gz");

    await spool.writeGzipArtifact(artifactPath, {
      retainedQuestions: retained,
      ...disabledRuntime
    });

    const parsed = JSON.parse(gunzipSync(await readFile(artifactPath)).toString("utf8")) as {
      questions: Array<{ question_id: string }>;
    };
    expect(parsed.questions.map((row) => row.question_id))
      .toEqual(full.map((row) => row.questionId));
    await spool.dispose();
  });
});

describe("RecallEvalDiagnosticsSpool retained bindings", () => {
  it.each([
    ["count", (rows: readonly RecallEvalQuestionResult[]) => rows.slice(0, 1)],
    ["order", (rows: readonly RecallEvalQuestionResult[]) => [...rows].reverse()],
    ["ID", (rows: readonly RecallEvalQuestionResult[]) => [
      { ...rows[0]!, questionId: "q-drift" }, rows[1]!
    ]]
  ])("fails closed on retained-question %s mismatch", async (_label, alter) => {
    const outputRoot = await mkdtemp(join(tmpdir(), "recall-eval-spool-mismatch-"));
    roots.push(outputRoot);
    const spool = await RecallEvalDiagnosticsSpool.create();
    const retained = await Promise.all(
      [question("q-1"), question("q-2")].map((row) => spool.append(row))
    );

    await expect(spool.writeGzipArtifact(join(outputRoot, "artifact.json.gz"), {
      retainedQuestions: alter(retained),
      ...disabledRuntime
    })).rejects.toThrow(/question|identity|order|count/u);
    await spool.dispose();
  });
});

describe("RecallEvalDiagnosticsSpool source integrity", () => {
  it("fails closed when the canonical source bytes change after append", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "recall-eval-spool-tamper-"));
    roots.push(outputRoot);
    const spool = await RecallEvalDiagnosticsSpool.create();
    const retained = [await spool.append(question("q-1"))];
    await appendFile(
      join(spool.rootPath, "recall-eval-questions.ndjson"),
      `${JSON.stringify({ question_id: "forged" })}\n`
    );

    await expect(spool.writeGzipArtifact(join(outputRoot, "artifact.json.gz"), {
      retainedQuestions: retained,
      ...disabledRuntime
    })).rejects.toThrow(/source identity|binding|schema/u);
    await spool.dispose();
  });
});

describe("RecallEvalDiagnosticsSpool lifecycle", () => {
  it("closes once and rejects work admitted after disposal starts", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "recall-eval-spool-closing-"));
    roots.push(outputRoot);
    const spool = await RecallEvalDiagnosticsSpool.create();
    await spool.append(question("q-before-close"));

    const disposal = spool.dispose();
    expect(spool.dispose()).toBe(disposal);
    await expect(spool.append(question("q-after-close"))).rejects.toThrow(/closing/u);
    await expect(spool.writeGzipArtifact(join(outputRoot, "late.json.gz"), {
      retainedQuestions: [],
      ...disabledRuntime
    })).rejects.toThrow(/closing/u);
    await disposal;
  });

  it("waits for an artifact write admitted before disposal", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "recall-eval-spool-drain-"));
    roots.push(outputRoot);
    const spool = await RecallEvalDiagnosticsSpool.create();
    const retained = [await spool.append(question("q-drain"))];
    const artifactPath = join(outputRoot, "artifact.json.gz");

    const writing = spool.writeGzipArtifact(artifactPath, {
      retainedQuestions: retained,
      ...disabledRuntime
    });
    await expect(spool.append(question("q-too-late"))).rejects.toThrow(/sealed/u);
    await Promise.all([writing, spool.dispose()]);
    await expect(access(artifactPath)).resolves.toBeUndefined();
  });
});

describe("RecallEvalDiagnosticsSpool source closure", () => {
  it("requires a final newline in its canonical source", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "recall-eval-spool-newline-"));
    roots.push(outputRoot);
    const spool = await RecallEvalDiagnosticsSpool.create();
    const retained = [await spool.append(question("q-1"))];
    const sourcePath = join(spool.rootPath, "recall-eval-questions.ndjson");
    await truncate(sourcePath, (await stat(sourcePath)).size - 1);

    await expect(spool.writeGzipArtifact(join(outputRoot, "artifact.json.gz"), {
      retainedQuestions: retained,
      ...disabledRuntime
    })).rejects.toThrow(/final newline/u);
    await spool.dispose();
  });
});

describe("RecallEvalDiagnosticsSpool owned-root cleanup", () => {
  it.each(["success", "failure"])("cleans its owned root after %s", async (mode) => {
    let ownedRoot = "";
    const run = withRecallEvalDiagnosticsSpool(async (spool) => {
      ownedRoot = spool.rootPath;
      await spool.append(question("q-cleanup"));
      if (mode === "failure") throw new Error("synthetic failure");
      return "done";
    });

    if (mode === "failure") await expect(run).rejects.toThrow("synthetic failure");
    else await expect(run).resolves.toBe("done");
    await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function question(questionId: string): RecallEvalQuestionResult {
  const base = promotionMeasurementDiagnostic(questionId, "scorable", true);
  const diagnostics = {
    ...base,
    provider_state: "provider_not_requested" as const,
    answer_rerank_status: "not_requested" as const,
    query_probes: { normalized_query: "x".repeat(1_024) }
  };
  return {
    questionId,
    hitAt1: true,
    hitAt5: true,
    hitAt10: true,
    firstTier: "hot",
    latencyMs: 12,
    degradationReason: null,
    diagnostics,
    tokenMetrics: emptyTokenMetrics(),
    recallTokenEconomy: {
      delivered_context_tokens_estimate: 10,
      coarse_pool_size: 5,
      fine_evaluated: 1,
      fine_pruned_count: 4,
      fine_priority_overflow_count: 0,
      fusion_families_with_hits: 1,
      embedding_inference_calls: 0
    },
    edgeProposalKpiRows: [],
    embeddingWarmup: null,
    queryEmbeddingWarmup: null,
    documentEmbeddingWarmupLatencyMs: null,
    deliveredObjectIds: diagnostics.delivered_results
      .map((row) => row.object_id)
      .filter((id): id is string => id !== undefined)
  };
}

function renderRank(rows: readonly RecallEvalQuestionResult[]): string {
  return renderRecallEvalRankIdentity(rows.map((row) => ({
    questionId: row.questionId,
    deliveredObjects: row.diagnostics.delivered_results.map((result) => ({
      object_id: result.object_id,
      object_kind: result.object_kind ?? "memory_entry"
    }))
  })), {
    expectedQuestionCount: rows.length,
    expectedQuestionIdDigest: null,
    requireFullSnapshotMatch: false
  });
}

function kpiInput(
  collected: readonly RecallEvalQuestionResult[]
): Parameters<typeof assembleRecallEvalKpi>[0] {
  const datasetSha256 = "d".repeat(64);
  return {
    collected,
    manifest: {
      question_count: collected.length,
      extraction_provenance: null
    } as Parameters<typeof assembleRecallEvalKpi>[0]["manifest"],
    variant: "longmemeval_s",
    runAt: new Date("2026-08-12T00:00:00.000Z"),
    commitSha7: "1749d78",
    alayaVersion: "0.3.11",
    policyShape: "stress",
    simulateReport: "none",
    sampleSize: collected.length,
    evaluatedCount: collected.length,
    recallWeightOverrides: undefined,
    embeddingProviderLabel: "none",
    datasetSha256,
    provenanceComplete: false,
    runtimeAttribution: kpiRuntimeAttribution(datasetSha256)
  };
}

function kpiRuntimeAttribution(datasetSha256: string) {
  return {
      status: "legacy_unattributed",
      gate_eligible: false,
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      embedding_mode: "disabled",
      embedding_provider_kind: "openai",
      embedding_provider_label: "none",
      onnx_threads: null,
      onnx_model_artifact_sha256: null,
      embedding_supplement: { enabled: false },
      answer_rerank: { enabled: false },
      recall_config: {
        schema_version: 2,
        max_results: 10,
        conflict_awareness: true,
        effective_config_sha256: "e".repeat(64)
      },
      hydration_binding: { dataset_sha256: datasetSha256, source: "external_expected_sha256" },
      snapshot_binding: {
        commit_sha7: "1749d78",
        gate_sha256: null,
        worktree_state_sha256: null,
        extraction_cache_manifest_sha256: null,
        extraction_cache_requested_turns: null,
        extraction_cache_cached_turns: null,
        extraction_cache_coverage: null,
        dataset_sha256: null,
        question_id_digest: null,
        snapshot_manifest_sha256: "f".repeat(64),
        producer_recall_pipeline_version: "fusion-rrf-synthesis-v2",
        consumer_recall_pipeline_version: "fusion-evidence-first-v3",
        producer_schema_migration_version: 103
      }
    } as Parameters<typeof assembleRecallEvalKpi>[0]["runtimeAttribution"];
}
