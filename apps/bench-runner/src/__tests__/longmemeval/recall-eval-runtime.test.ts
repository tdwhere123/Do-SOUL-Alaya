import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRecallEvalRuntimeAttribution,
  prepareRecallEvalDataDir
} from "../../longmemeval/lifecycle/recall-eval-runtime.js";
import { resolveLocalArtifactTreeSha256 } from "../../longmemeval/provenance/local-onnx.js";
import type { LongMemEvalSnapshotManifest } from "../../longmemeval/snapshot.js";
import { EXTRACTION_CACHE_MANIFEST_VERSION } from "../../longmemeval/extraction-cache-manifest.js";
import { buildEffectiveRecallConfigIdentity } from "../../longmemeval/provenance/effective-recall-config.js";
import { syntheticExtractionClosure } from "./extraction-closure-fixture.js";
import { compactSnapshotRunProvenance } from
  "../../longmemeval/snapshot/run-provenance.js";

function attributedManifest(onnxSha: string): LongMemEvalSnapshotManifest {
  const extractionClosure = syntheticExtractionClosure({
    count: 10,
    model: "fixture-model",
    requestProfile: "provider-default-v1",
    seed: "recall-eval-runtime"
  });
  return {
    schema_version: 1,
    variant: "longmemeval_s",
    question_count: 1,
    recall_pipeline_version: "test",
    schema_migration_version: 1,
    bench_runner_version: "test",
    alaya_commit: "05d98df",
    db_filename: "snapshot.db",
    sidecar_filename: "snapshot.db.sidecar.json",
    built_at: "2026-07-10T00:00:00.000Z",
    seed_extraction_path: {
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
    },
    extraction_provenance: {
      manifest_sha256: "1".repeat(64),
      schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
      extraction_model: "fixture-model",
      model_family: "fixture-family",
      request_profile: "provider-default-v1",
      provider_url: `sha256:${"2".repeat(64)}`,
      system_prompt_sha256: "3".repeat(64),
      cache_key_algo: "fixture-v1",
      dataset: "longmemeval-s",
      dataset_revision: "d".repeat(64),
      requested_turns: 10,
      cached_turns: 10,
      coverage: 1,
      fill_status: "complete",
      window_offset: 0,
      window_limit: 1,
      ...extractionClosure
    },
    artifact_integrity: {
      db_sha256: "a".repeat(64),
      sidecar_sha256: "b".repeat(64),
      extraction_authority_filename: "snapshot.db.extraction-authority.json",
      extraction_authority_sha256: "4".repeat(64),
      extraction_authority_bytes: 1
    },
    question_id_digest: "c".repeat(64),
    dataset_sha256: "d".repeat(64),
    attribution: { status: "attributed", gate_eligible: true },
    run_provenance: compactSnapshotRunProvenance({
      schema_version: 1,
      dataset_sha256: "d".repeat(64),
      selection: {
        schema_version: 1,
        dataset_sha256: "d".repeat(64),
        selected_id_digest: "c".repeat(64),
        selected_count: 1,
        expected_cohort_counts: { answerable: 1, abstention: 0 },
        cohort_assignment_digest: "8".repeat(64)
      },
      code: {
        commit_sha7: "05d98df",
        commit_sha: "05d98df" + "0".repeat(33),
        gate_sha256: "e".repeat(64),
        gate_contract_path: "/tmp/frozen-contract.json",
        worktree_state_sha256: "f".repeat(64),
        worktree_clean: true,
        executed_dist: {
          algorithm: "sha256-reachable-path-file-sha256-v1",
          sha256: "9".repeat(64),
          file_count: 1
        }
      },
      extraction_cache: {
        manifest_sha256: "1".repeat(64),
        schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
        extraction_model: "fixture-model",
        model_family: "fixture-family",
        request_profile: "provider-default-v1",
        provider_url: `sha256:${"2".repeat(64)}`,
        system_prompt_sha256: "3".repeat(64),
        cache_key_algo: "fixture-v1",
        dataset: "longmemeval-s",
        dataset_revision: "d".repeat(64),
        requested_turns: 10,
        cached_turns: 10,
        coverage: 1,
        fill_status: "complete",
        window_offset: 0,
        window_limit: 1,
        ...extractionClosure,
        storage: "git-tracked",
        built_at: "2026-07-01T00:00:00.000Z",
        builder: "test"
      },
      runtime: {
        node_version: process.version,
        platform: platform(),
        arch: arch(),
        embedding_mode: "env",
        embedding_provider_kind: "local_onnx",
        embedding_provider_label: "local_onnx:Xenova/test",
        onnx_threads: null,
        onnx_model_artifact_sha256: onnxSha,
        embedding_supplement: {
          enabled: true,
          provider_kind: "local_onnx",
          effective_model_id: "Xenova/test",
          model_artifact_sha256: onnxSha,
          effective_schema_version: 1,
          d2q_input: "raw_content"
        },
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
        ...buildEffectiveRecallConfigIdentity({}, {
          maxResults: 10,
          conflictAwareness: true
        })
      },
      question_manifest: null
    })
  };
}

describe("prepareRecallEvalDataDir", () => {
  const retainedRoots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(retainedRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });

  it("retains and reports its owned root when integrity validation fails", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "recall-eval-runtime-test-"));
    const snapshotPath = join(fixtureRoot, "snapshot.db");
    await writeFile(snapshotPath, "corrupt fixture", "utf8");
    await writeFile(`${snapshotPath}.sidecar.json`, "{}", "utf8");
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await expect(prepareRecallEvalDataDir({
      snapshotDbPath: snapshotPath,
      artifactIntegrity: {
        db_sha256: "0".repeat(64),
        sidecar_sha256: "0".repeat(64)
      }
    })).rejects.toThrow(/SHA-256 mismatch/i);

    const retained = writes.join("").match(/retained failed run evidence at (.+)\n/)?.[1];
    expect(retained).toBeDefined();
    retainedRoots.push(retained as string, fixtureRoot);
  });

  it("preserves the primary preparation error when failed-root finalization also fails", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "recall-eval-dual-failure-test-"));
    const snapshotPath = join(fixtureRoot, "snapshot.db");
    await writeFile(snapshotPath, "corrupt fixture", "utf8");
    await writeFile(`${snapshotPath}.sidecar.json`, "{}", "utf8");
    const cleanupError = new Error("failed-root reporting failed");
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw cleanupError;
    });

    try {
      await prepareRecallEvalDataDir({
        snapshotDbPath: snapshotPath,
        artifactIntegrity: {
          db_sha256: "0".repeat(64),
          sidecar_sha256: "0".repeat(64)
        }
      });
      throw new Error("expected preparation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors[0]).toMatchObject({
        message: expect.stringMatching(/SHA-256 mismatch/i)
      });
      expect((error as AggregateError).errors[1]).toBe(cleanupError);
    } finally {
      retainedRoots.push(fixtureRoot);
    }
  });

  it("retains and reports its owned root when restored DB validation fails", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "recall-eval-validation-test-"));
    const snapshotPath = join(fixtureRoot, "snapshot.db");
    await writeFile(snapshotPath, "snapshot fixture", "utf8");
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await expect(prepareRecallEvalDataDir({
      snapshotDbPath: snapshotPath,
      validateRestoredDb: () => { throw new Error("version mismatch"); }
    })).rejects.toThrow(/version mismatch/u);

    const retained = writes.join("").match(/retained failed run evidence at (.+)\n/)?.[1];
    expect(retained).toBeDefined();
    retainedRoots.push(retained as string, fixtureRoot);
  });

  it("attributes repeated local-ONNX recalls to the same hermetic model bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-eval-onnx-attribution-"));
    retainedRoots.push(root);
    await mkdir(join(root, "Xenova", "test"), { recursive: true });
    await mkdir(join(root, "Xenova", "reranker"), { recursive: true });
    await writeFile(join(root, "Xenova", "test", "model.onnx"), "fixture-model", "utf8");
    await writeFile(join(root, "Xenova", "reranker", "model.onnx"), "reranker", "utf8");
    const env = {
      ALAYA_RECALL_EVAL_EMBEDDING: "env",
      ALAYA_LOCAL_EMBEDDING_MODEL: "Xenova/test",
      ALAYA_LOCAL_EMBEDDING_CACHE_DIR: root,
      ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true",
      ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR: root,
      ALAYA_LOCAL_CROSS_ENCODER_MODEL: "Xenova/reranker",
      ALAYA_BENCH_GATE_SHA256: "e".repeat(64),
      ALAYA_BENCH_WORKTREE_STATE_SHA256: "f".repeat(64)
    };
    const sha = await resolveLocalArtifactTreeSha256(root, "Xenova/test");
    const manifest = attributedManifest(sha);

    const runs = await Promise.all([
      buildRecallEvalRuntimeAttribution(manifest, env),
      buildRecallEvalRuntimeAttribution(manifest, env),
      buildRecallEvalRuntimeAttribution(manifest, env)
    ]);

    expect(runs[0]).toEqual(runs[1]);
    expect(runs[1]).toEqual(runs[2]);
    expect(runs[0]).toMatchObject({
      status: "attributed",
      gate_eligible: true,
      embedding_provider_label: "local_onnx:Xenova/test",
      onnx_model_artifact_sha256: sha,
      answer_rerank: {
        enabled: true,
        provider_kind: "local_onnx_cross_encoder",
        effective_model_id: "Xenova/reranker",
        model_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      snapshot_binding: {
        producer_recall_pipeline_version: "test",
        consumer_recall_pipeline_version: "fusion-evidence-first-v3",
        producer_schema_migration_version: 1,
        snapshot_manifest_sha256: null,
        dataset_sha256: "d".repeat(64)
      }
    });

    for (const drift of [
      { ...env, ALAYA_BENCH_GATE_SHA256: "0".repeat(64) },
      { ...env, ALAYA_BENCH_WORKTREE_STATE_SHA256: "0".repeat(64) },
      { ...env, ALAYA_BENCH_GATE_SHA256: undefined }
    ]) {
      await expect(
        buildRecallEvalRuntimeAttribution(manifest, drift)
      ).resolves.toMatchObject({ gate_eligible: true });
    }

    const withoutCache = {
      ...manifest,
      run_provenance: {
        ...manifest.run_provenance!,
        extraction_cache: null
      }
    };
    await expect(buildRecallEvalRuntimeAttribution(withoutCache, env)).resolves.toMatchObject({
      status: "attributed",
      gate_eligible: false
    });
    const withoutFullCoverage = {
      ...manifest,
      run_provenance: {
        ...manifest.run_provenance!,
        extraction_cache: {
          ...manifest.run_provenance!.extraction_cache!,
          coverage: 0.9
        }
      }
    };
    await expect(
      buildRecallEvalRuntimeAttribution(withoutFullCoverage, env)
    ).resolves.toMatchObject({ gate_eligible: false });
    const withSnapshotCacheDrift = {
      ...manifest,
      extraction_provenance: {
        ...manifest.extraction_provenance!,
        extraction_model: "different-model"
      }
    };
    await expect(
      buildRecallEvalRuntimeAttribution(withSnapshotCacheDrift, env)
    ).resolves.toMatchObject({ gate_eligible: false });

    const withoutSeedExtractionPath = {
      ...manifest,
      seed_extraction_path: undefined
    };
    await expect(
      buildRecallEvalRuntimeAttribution(withoutSeedExtractionPath, env)
    ).resolves.toMatchObject({ gate_eligible: false });

    const withDegradedSeedExtractionPath = {
      ...manifest,
      seed_extraction_path: {
        ...manifest.seed_extraction_path!,
        offline_fallbacks: 1
      }
    };
    await expect(
      buildRecallEvalRuntimeAttribution(withDegradedSeedExtractionPath, env)
    ).resolves.toMatchObject({ gate_eligible: false });

    const disabledProducer = {
      ...manifest,
      run_provenance: {
        ...manifest.run_provenance!,
        runtime: {
          ...manifest.run_provenance!.runtime,
          embedding_mode: "disabled" as const,
          embedding_provider_kind: "local_onnx" as const,
          embedding_provider_label: "none",
          onnx_model_artifact_sha256: undefined,
          embedding_supplement: { enabled: false as const },
          answer_rerank: { enabled: false as const },
          paired_env: { ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "false" }
        }
      }
    };
    const arms = [
      { bi: false, cross: false },
      { bi: true, cross: false },
      { bi: false, cross: true },
      { bi: true, cross: true }
    ] as const;
    for (const arm of arms) {
      const attribution = await buildRecallEvalRuntimeAttribution(disabledProducer, {
        ...env,
        ALAYA_RECALL_EVAL_EMBEDDING: arm.bi ? "env" : "disabled",
        ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: arm.cross ? "true" : "false"
      });
      expect(attribution.gate_eligible).toBe(true);
      expect(attribution.embedding_supplement.enabled).toBe(arm.bi);
      expect(attribution.answer_rerank.enabled).toBe(arm.cross);
    }

    await expect(buildRecallEvalRuntimeAttribution({
      ...disabledProducer,
      attribution: { status: "legacy_unattributed", gate_eligible: false }
    }, env)).resolves.toMatchObject({
      status: "legacy_unattributed",
      gate_eligible: false
    });
    await expect(buildRecallEvalRuntimeAttribution(disabledProducer, {
      ...env,
      ALAYA_LOCAL_ONNX_THREADS: "two"
    })).rejects.toThrow(/ALAYA_LOCAL_ONNX_THREADS/u);
    await expect(buildRecallEvalRuntimeAttribution(disabledProducer, {
      ...env,
      ALAYA_LOCAL_ONNX_THREADS: "65"
    })).rejects.toThrow(/ALAYA_LOCAL_ONNX_THREADS/u);
  });
});
