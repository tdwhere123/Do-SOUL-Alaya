import type { SeedExtractionPath } from "@do-soul/alaya-eval";
import { describe, expect, it } from "vitest";
import type { LongMemEvalRunProvenance } from "../../longmemeval/provenance/run.js";
import type { SnapshotExtractionProvenance } from "../../longmemeval/snapshot.js";
import { deriveSnapshotAttribution } from "../../longmemeval/snapshot/attribution.js";
import type { ExtractionRequestProfile } from "../../longmemeval/extraction-cache-manifest.js";
import { syntheticExtractionClosure } from "./extraction-closure-fixture.js";
import { compactSnapshotRunProvenance } from
  "../../longmemeval/snapshot/run-provenance.js";

const DATASET_SHA = "a".repeat(64);
type FillStatus = "in_progress" | "complete";
const DEFAULT_CLOSURE = syntheticExtractionClosure({
  count: 10,
  model: "fixture-model",
  requestProfile: "provider-default-v1",
  seed: "snapshot-attribution"
});

function fillContract(
  status: FillStatus | null = "complete",
  digest = DEFAULT_CLOSURE.expected_key_set_sha256,
  contentClosure = DEFAULT_CLOSURE.content_closure_sha256,
  includeIndex = false
) {
  return status === null ? {} : {
    fill_status: status,
    window_offset: 0,
    window_limit: 1,
    expected_turns: 10,
    expected_key_set_sha256: digest,
    ...(status === "complete" ? {
      content_closure_sha256: contentClosure,
      ...(includeIndex ? {
        content_closure_index: DEFAULT_CLOSURE.content_closure_index
      } : {})
    } : {})
  } as const;
}

const CLEAN_SEED_EXTRACTION_PATH: SeedExtractionPath = {
  path: "official_api_compile",
  extraction_attempts: 10,
  cache_hits: 10,
  llm_calls: 0,
  offline_fallbacks: 0,
  live_extraction_failures: 0,
  cached_extraction_failures: 0,
  facts_produced: 10,
  signals_dropped: 0,
  parse_dropped: 0,
  compile_overflow_dropped: 0,
  signals_dropped_by_reason: {
    candidate_absent: 0,
    materialization_drop: 0
  }
};

function provenance(input: {
  readonly datasetRevision: string;
  readonly questionManifestDatasetSha?: string;
  readonly modelFamily?: string;
  readonly requestProfile?: ExtractionRequestProfile;
  readonly currentSelection?: boolean;
  readonly fillStatus?: FillStatus | null;
}): LongMemEvalRunProvenance {
  return {
    schema_version: 1,
    ...(input.currentSelection !== true ? {} : {
      dataset_sha256: DATASET_SHA,
      selection: {
        schema_version: 1,
        dataset_sha256: DATASET_SHA,
        selected_id_digest: "5".repeat(64),
        selected_count: 1,
        expected_cohort_counts: { answerable: 1, abstention: 0 },
        cohort_assignment_digest: "8".repeat(64)
      }
    }),
    code: {
      commit_sha7: "05d98df",
      commit_sha: "05d98df" + "0".repeat(33),
      gate_sha256: "b".repeat(64),
      gate_contract_path: "/tmp/frozen-contract.json",
      worktree_state_sha256: "c".repeat(64),
      worktree_clean: true,
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "6".repeat(64),
        file_count: 1
      }
    },
    extraction_cache: cacheIdentity(
      input.datasetRevision,
      input.modelFamily ?? "fixture-family",
      input.requestProfile ?? "provider-default-v1",
      input.fillStatus
    ),
    runtime: {
      node_version: "v24.0.0",
      platform: "linux",
      arch: "x64",
      embedding_mode: "disabled",
      embedding_provider_kind: "openai",
      embedding_provider_label: "none",
      onnx_threads: null,
      embedding_supplement: { enabled: false },
      answer_rerank: { enabled: false },
      paired_env: {}
    },
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset: 0,
      limit: 1,
      evaluated_count: 1
    },
    recall_config: {
      conf_slice_compatibility: false,
      schema_version: 2,
      max_results: 10,
      conflict_awareness: true,
      effective_config_sha256: "7".repeat(64)
    },
    question_manifest: questionManifestIdentity(input.questionManifestDatasetSha)
  };
}

function cacheIdentity(
  datasetRevision: string,
  modelFamily?: string,
  requestProfile?: ExtractionRequestProfile,
  fillStatus?: FillStatus | null
): NonNullable<LongMemEvalRunProvenance["extraction_cache"]> {
  const base = {
    manifest_sha256: "d".repeat(64),
    extraction_model: "fixture-model",
    provider_url: `sha256:${"e".repeat(64)}`,
    system_prompt_sha256: "f".repeat(64),
    cache_key_algo: "fixture-v1",
    dataset: "longmemeval-s",
    dataset_revision: datasetRevision,
    requested_turns: 10,
    cached_turns: 10,
    coverage: 1,
    storage: "git-tracked" as const,
    built_at: "2026-07-01T00:00:00.000Z",
    builder: "test"
  };
  return modelFamily === undefined
    ? { ...base, schema_version: 1 }
    : requestProfile === undefined
      ? { ...base, schema_version: 2, model_family: modelFamily }
      : {
          ...base,
          schema_version: 3,
          model_family: modelFamily,
          request_profile: requestProfile,
          ...fillContract(fillStatus, undefined, undefined, true)
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

function extraction(
  datasetRevision: string,
  modelFamily?: string,
  requestProfile?: ExtractionRequestProfile,
  fillStatus?: FillStatus | null,
  digest?: string,
  contentClosure?: string
): SnapshotExtractionProvenance {
  const base = {
    manifest_sha256: "d".repeat(64),
    extraction_model: "fixture-model",
    provider_url: `sha256:${"e".repeat(64)}`,
    system_prompt_sha256: "f".repeat(64),
    cache_key_algo: "fixture-v1",
    dataset: "longmemeval-s",
    dataset_revision: datasetRevision,
    requested_turns: 10,
    cached_turns: 10,
    coverage: 1
  };
  return modelFamily === undefined
    ? { ...base, schema_version: 1 }
    : requestProfile === undefined
      ? { ...base, schema_version: 2, model_family: modelFamily }
      : {
          ...base,
          schema_version: 3,
          model_family: modelFamily,
          request_profile: requestProfile,
          ...fillContract(fillStatus, digest, contentClosure)
        };
}

function attribution(input: {
  readonly datasetRevision: string;
  readonly questionManifestDatasetSha?: string;
  readonly snapshotDatasetRevision?: string;
  readonly modelFamily?: string;
  readonly snapshotModelFamily?: string;
  readonly requestProfile?: ExtractionRequestProfile;
  readonly snapshotRequestProfile?: ExtractionRequestProfile;
  readonly legacySchema?: 1 | 2;
  readonly snapshotManifestSha?: string;
  readonly snapshotCacheKeyAlgo?: string;
  readonly currentSelection?: boolean;
  readonly seedExtractionPath?: SeedExtractionPath | null;
  readonly fillStatus?: FillStatus | null;
  readonly snapshotFillStatus?: FillStatus | null;
  readonly snapshotFillDigest?: string;
  readonly snapshotContentClosure?: string;
  readonly snapshotWindowOffset?: number;
}) {
  const family = input.snapshotModelFamily ?? input.modelFamily ?? "fixture-family";
  const profile = input.snapshotRequestProfile ?? input.requestProfile ?? "provider-default-v1";
  const snapshotExtraction = input.legacySchema === 1
    ? extraction(input.snapshotDatasetRevision ?? input.datasetRevision)
    : input.legacySchema === 2
      ? extraction(input.snapshotDatasetRevision ?? input.datasetRevision, family)
      : extraction(
          input.snapshotDatasetRevision ?? input.datasetRevision,
          family,
          profile,
          input.snapshotFillStatus,
          input.snapshotFillDigest,
          input.snapshotContentClosure
        );
  return deriveSnapshotAttribution({
    artifactIntegrity: {
      db_sha256: "3".repeat(64),
      sidecar_sha256: "4".repeat(64),
      extraction_authority_filename: "snapshot.db.extraction-authority.json",
      extraction_authority_sha256: "6".repeat(64),
      extraction_authority_bytes: 1
    },
    runProvenance: input.legacySchema === undefined
      ? compactSnapshotRunProvenance(provenance(input))
      : {
          ...provenance(input),
          extraction_cache: input.legacySchema === 1
            ? cacheIdentity(input.datasetRevision)
            : cacheIdentity(input.datasetRevision, input.modelFamily ?? "fixture-family")
        },
    questionIdDigest: "5".repeat(64),
    datasetSha256: DATASET_SHA,
    ...(input.seedExtractionPath === null
      ? {}
      : { seedExtractionPath: input.seedExtractionPath ?? CLEAN_SEED_EXTRACTION_PATH }),
    extractionProvenance: {
      ...snapshotExtraction,
      manifest_sha256: input.snapshotManifestSha ?? snapshotExtraction.manifest_sha256,
      cache_key_algo: input.snapshotCacheKeyAlgo ?? snapshotExtraction.cache_key_algo,
      ...(input.snapshotWindowOffset === undefined
        ? {}
        : { window_offset: input.snapshotWindowOffset })
    }
  });
}

describe("snapshot attribution dataset binding", () => {
  it("accepts a v3 cache bound to carried dataset and selection identities", () => {
    expect(attribution({
      datasetRevision: DATASET_SHA,
      questionManifestDatasetSha: DATASET_SHA,
      currentSelection: true
    })).toEqual({ status: "attributed", gate_eligible: true });
  });

  it("keeps a statusless v3 cache readable but authority-ineligible", () => {
    expect(attribution({
      datasetRevision: DATASET_SHA,
      questionManifestDatasetSha: DATASET_SHA,
      currentSelection: true,
      fillStatus: null,
      snapshotFillStatus: null
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("keeps an in-progress v3 cache authority-ineligible", () => {
    expect(attribution({
      datasetRevision: DATASET_SHA,
      questionManifestDatasetSha: DATASET_SHA,
      currentSelection: true,
      fillStatus: "in_progress"
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("rejects snapshot provenance with a different completed fill key set", () => {
    expect(attribution({
      datasetRevision: DATASET_SHA,
      questionManifestDatasetSha: DATASET_SHA,
      currentSelection: true,
      snapshotFillDigest: "0".repeat(64)
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("rejects snapshot provenance with a different completed content closure", () => {
    expect(attribution({
      datasetRevision: DATASET_SHA,
      questionManifestDatasetSha: DATASET_SHA,
      currentSelection: true,
      snapshotContentClosure: "0".repeat(64)
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("rejects snapshot provenance with a different completed fill window", () => {
    expect(attribution({
      datasetRevision: DATASET_SHA,
      questionManifestDatasetSha: DATASET_SHA,
      currentSelection: true,
      snapshotWindowOffset: 1
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("keeps a snapshot without persisted seed extraction evidence gate-ineligible", () => {
    expect(attribution({
      datasetRevision: DATASET_SHA,
      questionManifestDatasetSha: DATASET_SHA,
      currentSelection: true,
      seedExtractionPath: null
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("keeps a snapshot with degraded seed extraction evidence gate-ineligible", () => {
    expect(attribution({
      datasetRevision: DATASET_SHA,
      questionManifestDatasetSha: DATASET_SHA,
      currentSelection: true,
      seedExtractionPath: {
        ...CLEAN_SEED_EXTRACTION_PATH,
        offline_fallbacks: 1
      }
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("keeps all-zero official extraction evidence gate-ineligible", () => {
    expect(attribution({
      datasetRevision: DATASET_SHA,
      questionManifestDatasetSha: DATASET_SHA,
      currentSelection: true,
      seedExtractionPath: {
        ...CLEAN_SEED_EXTRACTION_PATH,
        extraction_attempts: 0,
        cache_hits: 0,
        facts_produced: 0
      }
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("keeps inconsistent seed drop accounting gate-ineligible", () => {
    expect(attribution({
      datasetRevision: DATASET_SHA,
      questionManifestDatasetSha: DATASET_SHA,
      currentSelection: true,
      seedExtractionPath: {
        ...CLEAN_SEED_EXTRACTION_PATH,
        signals_dropped: 1
      }
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("rejects an unpinned v3 cache even when the question manifest binds dataset bytes", () => {
    expect(attribution({
      datasetRevision: "unpinned",
      questionManifestDatasetSha: DATASET_SHA
    })).toEqual({ status: "attributed", gate_eligible: false });
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

  it("rejects a snapshot whose comparison model family differs from run provenance", () => {
    expect(attribution({
      datasetRevision: "unpinned",
      questionManifestDatasetSha: DATASET_SHA,
      modelFamily: "deepseek-v4-flash",
      snapshotModelFamily: "other-family"
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("rejects a snapshot whose request profile differs from run provenance", () => {
    expect(attribution({
      datasetRevision: "unpinned",
      questionManifestDatasetSha: DATASET_SHA,
      requestProfile: "provider-default-v1",
      snapshotRequestProfile: "deepseek-v4-nonthinking-v1"
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it.each([1, 2] as const)(
    "keeps legacy v%d extraction provenance gate-ineligible",
    (legacySchema) => {
      expect(attribution({
        datasetRevision: "unpinned",
        questionManifestDatasetSha: DATASET_SHA,
        legacySchema
      })).toEqual({ status: "attributed", gate_eligible: false });
    }
  );

  it("rejects a manifest overwritten after run-start provenance was captured", () => {
    expect(attribution({
      datasetRevision: "unpinned",
      questionManifestDatasetSha: DATASET_SHA,
      snapshotManifestSha: "8".repeat(64)
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("rejects a cache-key algorithm drift after run start", () => {
    expect(attribution({
      datasetRevision: "unpinned",
      questionManifestDatasetSha: DATASET_SHA,
      snapshotCacheKeyAlgo: "fixture-v2"
    })).toEqual({ status: "attributed", gate_eligible: false });
  });

  it("rejects a hash-shaped cache revision without current carried selection identity", () => {
    expect(attribution({ datasetRevision: DATASET_SHA })).toEqual({
      status: "attributed",
      gate_eligible: false
    });
  });
});
