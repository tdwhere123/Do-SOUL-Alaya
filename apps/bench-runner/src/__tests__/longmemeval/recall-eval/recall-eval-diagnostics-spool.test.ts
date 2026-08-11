import { gunzipSync } from "node:zlib";
import { access, appendFile, mkdtemp, readFile, rm, stat, truncate } from
  "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleRecallEvalKpi } from
  "../../../longmemeval/kpi/recall-eval-payload.js";
import type { RecallEvalQuestionResult } from
  "../../../longmemeval/lifecycle/recall-eval/recall-eval-contract.js";
import {
  buildRecallEvalDiagnosticsEvidence,
  writeRecallEvalDiagnosticsGzipStream
} from
  "../../../longmemeval/provenance/recall-eval/recall-eval-diagnostics.js";
import {
  RecallEvalDiagnosticsSpool,
  withRecallEvalDiagnosticsSpool
} from
  "../../../longmemeval/provenance/recall-eval/recall-eval-diagnostics-spool.js";
import { renderRecallEvalRankIdentity } from
  "../../../longmemeval/provenance/recall-eval/recall-eval-rank-identity.js";
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
    deliveredObjectIds: diagnostics.delivered_results.map((row) => row.object_id)
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
