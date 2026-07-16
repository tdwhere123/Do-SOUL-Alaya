import { arch, platform } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLongMemEvalSelectionContractIdentity } from "@do-soul/alaya-eval";
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
import { syntheticExtractionClosure } from "./extraction-closure-fixture.js";
import {
  buildSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary
} from "../../longmemeval/snapshot/extraction-authority.js";
import { compactSnapshotRunProvenance } from
  "../../longmemeval/snapshot/run-provenance.js";

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
      const build = async (enabled: boolean): Promise<LongMemEvalRunProvenance> => {
        const built = await buildRecallEvalRunProvenance({
          manifest: manifest(),
          extractionAuthority: extractionAuthority(),
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
        return withFrozenCode(built);
      };
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
      expect(control).toMatchObject({ dataset_sha256: DATASET_SHA, selection });
      expect(isRecallEvalRunEvidenceEligible({
        runtimeAttribution: runtimeAttribution(biSha, crossSha),
        provenance: control,
        expectedQuestionIdDigest: selection.selected_id_digest,
        actualQuestionIdDigest: selection.selected_id_digest,
        evaluatedCount: dataset.length,
        offset: 0,
        limit: null
      })).toBe(true);

      const sliced = withFrozenCode(await buildRecallEvalRunProvenance({
        manifest: manifest(),
        extractionAuthority: extractionAuthority(),
        runtimeAttribution: runtimeAttribution(biSha, crossSha),
        evaluatedCount: dataset.length - 1,
        offset: 0,
        limit: dataset.length - 1,
        commitSha7: "05d98df",
        env: env(false, modelRoot),
        computeExecutedDistIdentity: async () => ({
          algorithm: "sha256-reachable-path-file-sha256-v1",
          sha256: "6".repeat(64),
          file_count: 3
        })
      }));
      expect(sliced.selection).toBeUndefined();
      expect(isRecallEvalRunEvidenceEligible({
        runtimeAttribution: runtimeAttribution(biSha, crossSha),
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
        extractionAuthority: extractionAuthority(),
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
