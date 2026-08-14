import { arch, platform } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLongMemEvalSelectionContractIdentity } from "@do-soul/alaya-eval";
import { describe, expect, it } from "vitest";
import {
  buildRecallEvalRunProvenance,
  isRecallEvalRunEvidenceEligible
} from "../../../longmemeval/provenance/recall-eval/recall-eval-run.js";
import { resolveLocalArtifactTreeSha256 } from "../../../longmemeval/provenance/embedding/local-onnx.js";
import {
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "../../../longmemeval/provenance/run.js";
import type { RecallEvalRuntimeAttribution } from "../../../longmemeval/lifecycle/recall-eval/recall-eval-runtime.js";
import { buildEffectiveRecallConfigIdentity } from "../../../longmemeval/provenance/effective-recall-config.js";
import type { LongMemEvalSnapshotManifest } from "../../../longmemeval/snapshot/materialize.js";
import {
  DATASET_SHA,
  dataset,
  provenance
} from "./recall-eval-provenance-contract-fixture.js";
import { syntheticExtractionClosure } from "../extraction/extraction-closure-fixture.js";
import {
  buildSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary
} from "../../../longmemeval/snapshot/extraction-authority.js";
import { compactSnapshotRunProvenance } from "../../../longmemeval/snapshot/run-provenance.js";

const archived = LongMemEvalRunProvenanceSchema.parse(provenance(false));
const EXTRACTION_CLOSURE = syntheticExtractionClosure({
  count: archived.extraction_cache!.requested_turns!,
  model: "cached-model",
  requestProfile: "provider-default-v1",
  seed: "recall-eval-provenance"
});
const selection = createLongMemEvalSelectionContractIdentity({
  datasetSha256: DATASET_SHA,
  assignments: dataset.map((question) => ({
    question_id: question.question_id,
    dataset_cohort: question.question_id.endsWith("_abs")
      ? "abstention" as const
      : "answerable" as const
  }))
});

function snapshotFixture() {
  const extractionCache = {
    ...archived.extraction_cache!,
    schema_version: 3 as const,
    model_family: "cached-model",
    request_profile: "provider-default-v1" as const,
    fill_status: "complete" as const,
    window_offset: 0,
    window_limit: dataset.length,
    ...EXTRACTION_CLOSURE
  };
  const runProvenance = LongMemEvalRunProvenanceSchema.parse({
    ...archived,
    dataset_sha256: DATASET_SHA,
    selection,
    code: {
      ...archived.code,
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "6".repeat(64),
        file_count: 3
      }
    },
    extraction_cache: extractionCache,
    recall_config: {
      conf_slice_compatibility: false,
      ...buildEffectiveRecallConfigIdentity({}, {
        maxResults: 10,
        conflictAwareness: true
      })
    }
  });
  const { manifest_sha256: sourceManifestSha256, ...sourceManifest } = extractionCache;
  const extraction = buildSnapshotExtractionSummary(
    sourceManifest,
    sourceManifestSha256
  );
  const extractionAuthority = buildSnapshotExtractionAuthority(
    sourceManifest,
    sourceManifestSha256,
    extraction
  );
  const manifest: LongMemEvalSnapshotManifest = {
    schema_version: 2,
    variant: "longmemeval_s",
    question_count: dataset.length,
    recall_pipeline_version: "test-v1",
    schema_migration_version: 1,
    bench_runner_version: "0.3.11",
    alaya_commit: archived.code.commit_sha7,
    db_filename: "snapshot.db",
    sidecar_filename: "snapshot.db.sidecar.json",
    built_at: "2026-07-10T00:00:00.000Z",
    extraction_provenance: extraction,
    run_provenance: compactSnapshotRunProvenance(runProvenance),
    question_id_digest: selection.selected_id_digest,
    dataset_sha256: DATASET_SHA,
    attribution: { status: "attributed", gate_eligible: true }
  };
  return { manifest, extractionAuthority };
}

function manifest(): LongMemEvalSnapshotManifest {
  return snapshotFixture().manifest;
}

function extractionAuthority() {
  return snapshotFixture().extractionAuthority;
}

function withFrozenCode(
  provenance: LongMemEvalRunProvenance
): LongMemEvalRunProvenance {
  return LongMemEvalRunProvenanceSchema.parse({
    ...provenance,
    code: {
      ...provenance.code,
      commit_sha: "05d98df" + "0".repeat(33),
      gate_sha256: "d".repeat(64),
      gate_contract_path: "/tmp/frozen-contract.json",
      worktree_state_sha256: "1".repeat(64),
      worktree_clean: true
    }
  });
}

function runtimeAttribution(biSha: string): RecallEvalRuntimeAttribution {
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
    answer_rerank: { enabled: false },
    recall_config: buildEffectiveRecallConfigIdentity({}, {
      maxResults: 10,
      conflictAwareness: true
    }),
    query_semantic_factor_cache: {
      schema_version: 2,
      cache_content_sha256: `sha256:${"3".repeat(64)}`,
      compiler_operator_id: "open_semantic_factor_query_compiler_v2",
      system_prompt_sha256: `sha256:${"4".repeat(64)}`,
      model_id: "DeepSeek-V4-Flash",
      provider_url_sha256: `sha256:${"5".repeat(64)}`,
      source_set_sha256: `sha256:${"7".repeat(64)}`,
      entry_count: 100,
      transport_routes: [{
        provider_url_sha256: `sha256:${"9".repeat(64)}`,
        model: "deepseek-v4-flash"
      }]
    },
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

function env(modelRoot: string): Readonly<Record<string, string>> {
  return {
    ...archived.runtime.paired_env,
    ALAYA_LOCAL_ONNX_THREADS: "2",
    ALAYA_LOCAL_EMBEDDING_CACHE_DIR: modelRoot,
    ALAYA_LOCAL_EMBEDDING_MODEL: "Xenova/test",
    ALAYA_RECALL_FACET_TAGS: "0"
  };
}

describe("recall-eval provenance producer contract", () => {
  it("emits a strict current archive and refuses unbound runtime evidence", async () => {
    const modelRoot = await mkdtemp(join(tmpdir(), "recall-eval-provenance-"));
    await mkdir(join(modelRoot, "Xenova", "test"), { recursive: true });
    await writeFile(join(modelRoot, "Xenova", "test", "model.onnx"), "bi", "utf8");
    try {
      const biSha = await resolveLocalArtifactTreeSha256(modelRoot, "Xenova/test");
      const build = async (): Promise<LongMemEvalRunProvenance> => {
        const built = await buildRecallEvalRunProvenance({
          manifest: manifest(),
          extractionAuthority: extractionAuthority(),
          runtimeAttribution: runtimeAttribution(biSha),
          evaluatedCount: dataset.length,
          offset: 0,
          limit: null,
          commitSha7: "05d98df",
          env: env(modelRoot),
          computeExecutedDistIdentity: async () => ({
            algorithm: "sha256-reachable-path-file-sha256-v1",
            sha256: "6".repeat(64),
            file_count: 3
          })
        });
        return withFrozenCode(built);
      };
      const control = await build();

      expect(LongMemEvalRunProvenanceSchema.parse(control)).toEqual(control);
      expect(control.code.executed_dist).toMatchObject({ sha256: "6".repeat(64), file_count: 3 });
      expect(control.runtime.answer_rerank).toEqual({ enabled: false });
      expect(control.runtime.query_semantic_factor_cache).toEqual(
        runtimeAttribution(biSha).query_semantic_factor_cache
      );
      expect(control.seed_capabilities).toEqual({ facet_tags_enabled: true });
      expect(control).toMatchObject({ dataset_sha256: DATASET_SHA, selection });
      expect(isRecallEvalRunEvidenceEligible({
        runtimeAttribution: runtimeAttribution(biSha),
        provenance: control,
        expectedQuestionIdDigest: selection.selected_id_digest,
        actualQuestionIdDigest: selection.selected_id_digest,
        evaluatedCount: dataset.length,
        offset: 0,
        limit: null
      })).toBe(true);
      expect(isRecallEvalRunEvidenceEligible({
        runtimeAttribution: {
          ...runtimeAttribution(biSha),
          query_semantic_factor_cache: {
            ...runtimeAttribution(biSha).query_semantic_factor_cache!,
            cache_content_sha256: `sha256:${"a".repeat(64)}`
          }
        },
        provenance: control,
        expectedQuestionIdDigest: selection.selected_id_digest,
        actualQuestionIdDigest: selection.selected_id_digest,
        evaluatedCount: dataset.length,
        offset: 0,
        limit: null
      })).toBe(false);

      const sliced = withFrozenCode(await buildRecallEvalRunProvenance({
        manifest: manifest(),
        extractionAuthority: extractionAuthority(),
        runtimeAttribution: runtimeAttribution(biSha),
        evaluatedCount: dataset.length - 1,
        offset: 0,
        limit: dataset.length - 1,
        commitSha7: "05d98df",
        env: env(modelRoot),
        computeExecutedDistIdentity: async () => ({
          algorithm: "sha256-reachable-path-file-sha256-v1",
          sha256: "6".repeat(64),
          file_count: 3
        })
      }));
      expect(sliced.selection).toBeUndefined();
      expect(isRecallEvalRunEvidenceEligible({
        runtimeAttribution: runtimeAttribution(biSha),
        provenance: sliced,
        expectedQuestionIdDigest: selection.selected_id_digest,
        actualQuestionIdDigest: selection.selected_id_digest,
        evaluatedCount: dataset.length - 1,
        offset: 0,
        limit: dataset.length - 1
      })).toBe(false);
      await expect(buildRecallEvalRunProvenance({
        manifest: manifest(),
        extractionAuthority: extractionAuthority(),
        runtimeAttribution: runtimeAttribution(biSha),
        evaluatedCount: dataset.length,
        offset: 0,
        limit: null,
        commitSha7: "05d98df",
        env: {
          ...env(modelRoot),
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
        extractionAuthority: extractionAuthority(),
        runtimeAttribution: runtimeAttribution(biSha),
        evaluatedCount: dataset.length,
        offset: 0,
        limit: null,
        commitSha7: "05d98df",
        env: env(modelRoot),
        computeExecutedDistIdentity: async () => null
      })).rejects.toThrow(/executed dist closure/u);
      expect(isRecallEvalRunEvidenceEligible({
        runtimeAttribution: {
          ...runtimeAttribution(biSha),
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
    } finally {
      await rm(modelRoot, { recursive: true, force: true });
    }
  });
});
