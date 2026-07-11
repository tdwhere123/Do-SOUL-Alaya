import { describe, expect, it } from "vitest";
import type { LongMemEvalRunProvenance } from "../../longmemeval/provenance/run.js";
import type { SnapshotExtractionProvenance } from "../../longmemeval/snapshot.js";
import { deriveSnapshotAttribution } from "../../longmemeval/snapshot/attribution.js";

const DATASET_SHA = "a".repeat(64);

function provenance(input: {
  readonly datasetRevision: string;
  readonly questionManifestDatasetSha?: string;
}): LongMemEvalRunProvenance {
  return {
    schema_version: 1,
    code: {
      commit_sha7: "05d98df",
      gate_sha256: "b".repeat(64),
      worktree_state_sha256: "c".repeat(64)
    },
    extraction_cache: cacheIdentity(input.datasetRevision),
    runtime: {
      node_version: "v24.0.0",
      platform: "linux",
      arch: "x64",
      embedding_mode: "disabled",
      embedding_provider_kind: "openai",
      embedding_provider_label: "none",
      onnx_threads: null,
      paired_env: {}
    },
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset: 0,
      limit: 1,
      evaluated_count: 1
    },
    recall_config: { conf_slice_compatibility: false },
    question_manifest: questionManifestIdentity(input.questionManifestDatasetSha)
  };
}

function cacheIdentity(
  datasetRevision: string
): NonNullable<LongMemEvalRunProvenance["extraction_cache"]> {
  return {
    manifest_sha256: "d".repeat(64),
    schema_version: 1,
    extraction_model: "fixture-model",
    provider_url: `sha256:${"e".repeat(64)}`,
    system_prompt_sha256: "f".repeat(64),
    cache_key_algo: "fixture-v1",
    dataset: "longmemeval-s",
    dataset_revision: datasetRevision,
    requested_turns: 10,
    cached_turns: 10,
    coverage: 1,
    storage: "git-tracked",
    built_at: "2026-07-01T00:00:00.000Z",
    builder: "test"
  };
}

function questionManifestIdentity(
  datasetSha: string | undefined
): LongMemEvalRunProvenance["question_manifest"] {
  return datasetSha === undefined ? null : {
    schema_version: 1,
    variant: "longmemeval_s",
    dataset_sha256: datasetSha,
    algorithm_version: "fixture-v1",
    target_count: 1,
    selected_id_digest: "1".repeat(64),
    file_sha256: "2".repeat(64)
  };
}

function extraction(datasetRevision: string): SnapshotExtractionProvenance {
  return {
    extraction_model: "fixture-model",
    provider_url: `sha256:${"e".repeat(64)}`,
    system_prompt_sha256: "f".repeat(64),
    dataset: "longmemeval-s",
    dataset_revision: datasetRevision,
    requested_turns: 10,
    cached_turns: 10,
    coverage: 1
  };
}

function attribution(input: {
  readonly datasetRevision: string;
  readonly questionManifestDatasetSha?: string;
  readonly snapshotDatasetRevision?: string;
}) {
  return deriveSnapshotAttribution({
    artifactIntegrity: {
      db_sha256: "3".repeat(64),
      sidecar_sha256: "4".repeat(64)
    },
    runProvenance: provenance(input),
    questionIdDigest: "5".repeat(64),
    datasetSha256: DATASET_SHA,
    extractionProvenance: extraction(
      input.snapshotDatasetRevision ?? input.datasetRevision
    )
  });
}

describe("snapshot attribution dataset binding", () => {
  it("accepts an unpinned cache revision when the question manifest binds dataset bytes", () => {
    expect(attribution({
      datasetRevision: "unpinned",
      questionManifestDatasetSha: DATASET_SHA
    })).toEqual({ status: "attributed", gate_eligible: true });
  });

  it("rejects a question manifest whose dataset SHA differs from the snapshot", () => {
    expect(attribution({
      datasetRevision: "unpinned",
      questionManifestDatasetSha: "9".repeat(64)
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("rejects an unpinned cache without a question manifest dataset binding", () => {
    expect(attribution({ datasetRevision: "unpinned" })).toEqual({
      status: "attributed",
      gate_eligible: false
    });
  });

  it("rejects a snapshot whose cache revision label differs from run provenance", () => {
    expect(attribution({
      datasetRevision: "unpinned",
      questionManifestDatasetSha: DATASET_SHA,
      snapshotDatasetRevision: "different-revision"
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("uses a hash-shaped cache revision as the legacy dataset binding fallback", () => {
    expect(attribution({ datasetRevision: DATASET_SHA })).toEqual({
      status: "attributed",
      gate_eligible: true
    });
  });
});
