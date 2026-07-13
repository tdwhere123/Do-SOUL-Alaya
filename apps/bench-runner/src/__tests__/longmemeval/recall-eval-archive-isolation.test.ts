import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  entrySlug,
  writeEntry,
  type HistoryLayout
} from "@do-soul/alaya-eval";
import {
  RECALL_EVAL_ARCHIVE_MARKER,
  isRecallEvalArchive,
  selectFullRunBaseline
} from "../../longmemeval/recall-eval-archive.js";
import { assembleRecallEvalKpi } from "../../longmemeval/recall-eval-kpi.js";
import { buildPublicPayload } from "./recall-eval/archive-fixture.js";

// @anchor recall-eval-archive-isolation — a fast-loop recall-eval archive
// shares the public/ bench + (split, policy, simulate, provider) bucket with
// full runs, but never paid extraction/materialization. It must carry an
// explicit discriminator and must never be selected as a full-run baseline.
// cross-file: apps/bench-runner/src/longmemeval/recall-eval-archive.ts

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
  it("preserves archive identity for an assembled legacy payload", () => {
    const payload = assembleRecallEvalKpi({
      collected: [],
      manifest: {
        schema_version: 1,
        variant: "longmemeval_s",
        question_count: 1,
        recall_pipeline_version: "fusion-rrf-synthesis-v2",
        schema_migration_version: 103,
        bench_runner_version: "0.3.11",
        alaya_commit: "d7266aa",
        db_filename: "snapshot.db",
        sidecar_filename: "snapshot.db.sidecar.json",
        built_at: "2026-07-12T00:00:00.000Z"
      },
      variant: "longmemeval_s",
      runAt: new Date("2026-07-12T00:00:00.000Z"),
      commitSha7: "aba63cb",
      alayaVersion: "0.3.11",
      policyShape: "stress",
      simulateReport: "none",
      sampleSize: 1,
      evaluatedCount: 0,
      recallWeightOverrides: undefined,
      embeddingProviderLabel: "none",
      datasetSha256: "b".repeat(64),
      provenanceComplete: false,
      runtimeAttribution: {
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
        hydration_binding: {
          dataset_sha256: "b".repeat(64),
          source: "external_expected_sha256"
        },
        snapshot_binding: {
          commit_sha7: "d7266aa",
          gate_sha256: null,
          worktree_state_sha256: null,
          extraction_cache_manifest_sha256: null,
          extraction_cache_requested_turns: null,
          extraction_cache_cached_turns: null,
          extraction_cache_coverage: null,
          dataset_sha256: null,
          question_id_digest: null,
          snapshot_manifest_sha256: "d".repeat(64),
          producer_recall_pipeline_version: "fusion-rrf-synthesis-v2",
          consumer_recall_pipeline_version: "fusion-evidence-first-v3",
          producer_schema_migration_version: 103
        }
      }
    });

    expect(isRecallEvalArchive(payload)).toBe(true);
    expect(payload.dataset.checksum_source).toBe(
      `${RECALL_EVAL_ARCHIVE_MARKER} external evaluator dataset binding`
    );
  });

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
