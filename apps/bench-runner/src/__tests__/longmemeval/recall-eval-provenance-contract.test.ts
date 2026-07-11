import { arch, platform } from "node:os";
import { describe, expect, it } from "vitest";
import { compareLongMemEvalQuestionTypes } from "../../longmemeval/comparison/question-type-comparison.js";
import { buildRecallEvalRunProvenance } from "../../longmemeval/provenance/recall-eval-run.js";
import {
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "../../longmemeval/provenance/run.js";
import type { RecallEvalRuntimeAttribution } from "../../longmemeval/lifecycle/recall-eval-runtime.js";
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

function runtimeAttribution(): RecallEvalRuntimeAttribution {
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
    onnx_model_artifact_sha256: "9".repeat(64),
    snapshot_binding: {
      commit_sha7: "05d98df",
      gate_sha256: "d".repeat(64),
      worktree_state_sha256: "1".repeat(64),
      extraction_cache_manifest_sha256: "e".repeat(64),
      extraction_cache_requested_turns: 10,
      extraction_cache_cached_turns: 10,
      extraction_cache_coverage: 1,
      dataset_sha256: "a".repeat(64),
      question_id_digest: "8".repeat(64)
    }
  };
}

function env(enabled: boolean): Readonly<Record<string, string>> {
  return {
    ...archived.runtime.paired_env,
    ALAYA_BENCH_GATE_SHA256: archived.code.gate_sha256!,
    ALAYA_BENCH_WORKTREE_STATE_SHA256: archived.code.worktree_state_sha256!,
    ALAYA_LOCAL_ONNX_THREADS: "2",
    ALAYA_RECALL_FACET_TAGS: "0",
    ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: enabled ? "on" : "off"
  };
}

describe("recall-eval provenance producer/comparator contract", () => {
  it("emits a strict paired archive whose sole A/B difference is the slice switch", () => {
    const build = (enabled: boolean): LongMemEvalRunProvenance =>
      buildRecallEvalRunProvenance({
        manifest: manifest(),
        runtimeAttribution: runtimeAttribution(),
        evaluatedCount: dataset.length,
        offset: 0,
        limit: null,
        commitSha7: "05d98df",
        env: env(enabled)
      });
    const control = build(false);
    const treatment = build(true);
    const rows = dataset.map((row) => ({ id: row.question_id, hit_at_5: true }));

    expect(LongMemEvalRunProvenanceSchema.parse(control)).toEqual(control);
    expect(LongMemEvalRunProvenanceSchema.parse(treatment)).toEqual(treatment);
    expect(control.seed_capabilities).toEqual({ facet_tags_enabled: true });
    expect(treatment.seed_capabilities).toEqual({ facet_tags_enabled: true });
    expect(compareLongMemEvalQuestionTypes({
      dataset,
      datasetSha256: DATASET_SHA,
      control: kpi(rows),
      treatment: kpi(rows),
      controlProvenance: control,
      treatmentProvenance: treatment
    })).toMatchObject({
      evidence_grade: "paired_attributed",
      gate: { pass: false }
    });
  });
});
