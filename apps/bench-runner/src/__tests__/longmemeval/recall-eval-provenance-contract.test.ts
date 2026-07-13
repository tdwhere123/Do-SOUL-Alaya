import { arch, platform } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareLongMemEvalQuestionTypes } from "../../longmemeval/comparison/question-type-comparison.js";
import {
  buildRecallEvalRunProvenance,
  isRecallEvalRunEvidenceEligible
} from "../../longmemeval/provenance/recall-eval-run.js";
import { resolveLocalArtifactTreeSha256 } from "../../longmemeval/provenance/local-onnx.js";
import {
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "../../longmemeval/provenance/run.js";
import type { RecallEvalRuntimeAttribution } from "../../longmemeval/lifecycle/recall-eval-runtime.js";
import { buildEffectiveRecallConfigIdentity } from "../../longmemeval/provenance/effective-recall-config.js";
import type { LongMemEvalSnapshotManifest } from "../../longmemeval/snapshot.js";
import {
  DATASET_SHA,
  dataset,
  kpi,
  provenance
} from "./question-type-comparison-test-fixtures.js";

const archived = LongMemEvalRunProvenanceSchema.parse(provenance(false));

function manifest(): LongMemEvalSnapshotManifest {
  return {
    schema_version: 1,
    variant: "longmemeval_s",
    question_count: dataset.length,
    recall_pipeline_version: "test-v1",
    schema_migration_version: 1,
    bench_runner_version: "0.3.11",
    alaya_commit: archived.code.commit_sha7,
    db_filename: "snapshot.db",
    sidecar_filename: "snapshot.db.sidecar.json",
    built_at: "2026-07-10T00:00:00.000Z",
    extraction_provenance: null,
    run_provenance: archived,
    question_id_digest: "8".repeat(64),
    dataset_sha256: archived.extraction_cache!.dataset_revision,
    attribution: { status: "attributed", gate_eligible: true }
  };
}

function runtimeAttribution(
  biSha: string,
  crossSha: string
): RecallEvalRuntimeAttribution {
  return {
    status: "attributed",
    gate_eligible: true,
    node_version: process.version,
    platform: platform(),
    arch: arch(),
    embedding_mode: "env",
    embedding_provider_kind: "local_onnx",
    embedding_provider_label: "local_onnx:Xenova/test",
    onnx_threads: 2,
    onnx_model_artifact_sha256: biSha,
    embedding_supplement: {
      enabled: true,
      provider_kind: "local_onnx",
      effective_model_id: "Xenova/test",
      model_artifact_sha256: biSha,
      effective_schema_version: 1,
      d2q_input: "raw_content"
    },
    answer_rerank: {
      enabled: true,
      provider_kind: "local_onnx_cross_encoder",
      effective_model_id: "Xenova/reranker",
      model_artifact_sha256: crossSha
    },
    recall_config: buildEffectiveRecallConfigIdentity({}, {
      maxResults: 10,
      conflictAwareness: true
    }),
    snapshot_binding: {
      commit_sha7: "05d98df",
      gate_sha256: "d".repeat(64),
      worktree_state_sha256: "1".repeat(64),
      extraction_cache_manifest_sha256: "e".repeat(64),
      extraction_cache_requested_turns: 10,
      extraction_cache_cached_turns: 10,
      extraction_cache_coverage: 1,
      dataset_sha256: "a".repeat(64),
      question_id_digest: "8".repeat(64),
      snapshot_manifest_sha256: "2".repeat(64),
      producer_recall_pipeline_version: "test-v1",
      consumer_recall_pipeline_version: "test-v1",
      producer_schema_migration_version: 1
    }
  };
}

function env(enabled: boolean, modelRoot: string): Readonly<Record<string, string>> {
  return {
    ...archived.runtime.paired_env,
    ALAYA_BENCH_GATE_SHA256: archived.code.gate_sha256!,
    ALAYA_BENCH_WORKTREE_STATE_SHA256: archived.code.worktree_state_sha256!,
    ALAYA_LOCAL_ONNX_THREADS: "2",
    ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true",
    ALAYA_LOCAL_EMBEDDING_CACHE_DIR: modelRoot,
    ALAYA_LOCAL_EMBEDDING_MODEL: "Xenova/test",
    ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR: modelRoot,
    ALAYA_LOCAL_CROSS_ENCODER_MODEL: "Xenova/reranker",
    ALAYA_RECALL_FACET_TAGS: "0",
    ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: enabled ? "on" : "off"
  };
}

describe("recall-eval provenance producer/comparator contract", () => {
  it("emits a strict paired archive whose sole A/B difference is the slice switch", async () => {
    const modelRoot = await mkdtemp(join(tmpdir(), "recall-eval-provenance-"));
    await mkdir(join(modelRoot, "Xenova", "test"), { recursive: true });
    await mkdir(join(modelRoot, "Xenova", "reranker"), { recursive: true });
    await writeFile(join(modelRoot, "Xenova", "test", "model.onnx"), "bi", "utf8");
    await writeFile(join(modelRoot, "Xenova", "reranker", "model.onnx"), "cross", "utf8");
    try {
      const biSha = await resolveLocalArtifactTreeSha256(modelRoot, "Xenova/test");
      const crossSha = await resolveLocalArtifactTreeSha256(modelRoot, "Xenova/reranker");
      const build = async (enabled: boolean): Promise<LongMemEvalRunProvenance> =>
        await buildRecallEvalRunProvenance({
          manifest: manifest(),
          runtimeAttribution: runtimeAttribution(biSha, crossSha),
          evaluatedCount: dataset.length,
          offset: 0,
          limit: null,
          commitSha7: "05d98df",
          env: env(enabled, modelRoot),
          computeExecutedDistIdentity: async () => ({
            algorithm: "sha256-reachable-path-file-sha256-v1",
            sha256: "6".repeat(64),
            file_count: 3
          })
        });
      const [control, treatment] = await Promise.all([build(false), build(true)]);
      const rows = dataset.map((row) => ({ id: row.question_id, hit_at_5: true }));

      expect(LongMemEvalRunProvenanceSchema.parse(control)).toEqual(control);
      expect(control.code.executed_dist).toMatchObject({ sha256: "6".repeat(64), file_count: 3 });
      expect(control.runtime.answer_rerank).toEqual({
        enabled: true,
        provider_kind: "local_onnx_cross_encoder",
        effective_model_id: "Xenova/reranker",
        model_artifact_sha256: crossSha
      });
      expect(control.seed_capabilities).toEqual({ facet_tags_enabled: true });
      expect(treatment.seed_capabilities).toEqual({ facet_tags_enabled: true });
      await expect(buildRecallEvalRunProvenance({
        manifest: manifest(),
        runtimeAttribution: runtimeAttribution(biSha, crossSha),
        evaluatedCount: dataset.length,
        offset: 0,
        limit: null,
        commitSha7: "05d98df",
        env: {
          ...env(false, modelRoot),
          ALAYA_BENCH_EXECUTED_DIST_CLOSURE_SHA256: "7".repeat(64),
          ALAYA_BENCH_EXECUTED_DIST_FILE_COUNT: "3"
        },
        computeExecutedDistIdentity: async () => ({
          algorithm: "sha256-reachable-path-file-sha256-v1",
          sha256: "6".repeat(64),
          file_count: 3
        })
      })).rejects.toThrow(/executed dist environment identity/u);
      await expect(buildRecallEvalRunProvenance({
        manifest: manifest(),
        runtimeAttribution: runtimeAttribution(biSha, crossSha),
        evaluatedCount: dataset.length,
        offset: 0,
        limit: null,
        commitSha7: "05d98df",
        env: env(false, modelRoot),
        computeExecutedDistIdentity: async () => null
      })).rejects.toThrow(/executed dist closure/u);
      expect(isRecallEvalRunEvidenceEligible({
        runtimeAttribution: {
          ...runtimeAttribution(biSha, crossSha),
          status: "legacy_unattributed",
          gate_eligible: false
        },
        provenance: control,
        expectedQuestionIdDigest: "8".repeat(64),
        actualQuestionIdDigest: "8".repeat(64),
        evaluatedCount: dataset.length,
        offset: 0,
        limit: null
      })).toBe(false);
      expect(compareLongMemEvalQuestionTypes({
        dataset,
        datasetSha256: DATASET_SHA,
        control: kpi(rows),
        treatment: kpi(rows),
        controlProvenance: control,
        treatmentProvenance: treatment
      })).toMatchObject({ evidence_grade: "paired_attributed", gate: { pass: false } });
    } finally {
      await rm(modelRoot, { recursive: true, force: true });
    }
  });
});
