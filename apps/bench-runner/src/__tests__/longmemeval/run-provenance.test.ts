import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStratifiedQuestionManifest } from "../../longmemeval/selection/question-manifest.js";
import {
  buildLongMemEvalRunProvenance,
  buildLongMemEvalRunProvenanceSidecar,
  LONGMEMEVAL_RUN_PROVENANCE_FILENAME
} from "../../longmemeval/provenance/run.js";
import { resolveLocalOnnxArtifactSha256 } from "../../longmemeval/provenance/local-onnx.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  writeExtractionCacheManifest
} from "../../longmemeval/extraction-cache-manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LongMemEval run provenance", () => {
  it("archives the validated manifest identity, sequential protocol, and slice switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "lme-provenance-"));
    roots.push(root);
    const manifestPath = join(root, "manifest.json");
    const extractionCacheRoot = join(root, "extraction-cache");
    const modelCacheRoot = join(root, "models");
    await mkdir(join(modelCacheRoot, "Xenova", "test"), { recursive: true });
    await writeFile(join(modelCacheRoot, "Xenova", "test", "config.json"), "model-config", {
      encoding: "utf8",
      flag: "w"
    });
    const manifest = createStratifiedQuestionManifest({
      variant: "longmemeval_s",
      datasetSha256: "a".repeat(64),
      questions: [{
        question_id: "q-1",
        question_type: "multi-session",
        question: "q",
        answer: "a",
        question_date: "2026-01-01",
        haystack_session_ids: [],
        haystack_dates: [],
        haystack_sessions: [],
        answer_session_ids: []
      }],
      targetCount: 1
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    writeExtractionCacheManifest(extractionCacheRoot, {
      schema_version: 1,
      extraction_model: "cached-model",
      provider_url: "https://provider.invalid/v1",
      system_prompt_sha256: "b".repeat(64),
      cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
      dataset: "longmemeval-s",
      dataset_revision: "a".repeat(64),
      requested_turns: 10,
      cached_turns: 10,
      coverage: 1,
      storage: "archive",
      archive_url: "https://cache.invalid/archive.tar.zst",
      archive_sha256: "c".repeat(64),
      built_at: "2026-07-01T00:00:00.000Z",
      builder: "test"
    });

    const provenance = await buildLongMemEvalRunProvenance({
      opts: {
        variant: "longmemeval_s",
        historyRoot: root,
        questionManifest: manifestPath,
        extractionCacheRoot,
        embeddingMode: "env",
        embeddingProviderKind: "local_onnx"
      },
      evaluatedCount: 1,
      commitSha7: "05d98df",
      embeddingProviderLabel: "local_onnx:Xenova/test",
      env: {
        ALAYA_BENCH_GATE_SHA256: "d".repeat(64),
        ALAYA_BENCH_WORKTREE_STATE_SHA256: "1".repeat(64),
        ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: "on",
        ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0",
        ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE: "1",
        OFFICIAL_API_GARDEN_MODEL: "cached-model",
        ALAYA_LOCAL_ONNX_THREADS: "2",
        ALAYA_LOCAL_EMBEDDING_CACHE_DIR: modelCacheRoot,
        ALAYA_EXP_ANSWERS_WITH_CAP: "3",
        ALAYA_RECALL_ANSWERS_WITH: "1",
        ALAYA_RECALL_FACET_TAGS: "1",
        ALAYA_RECALL_COVERAGE_SELECTOR: "https://example.invalid/select?signature=secret",
        ALAYA_INGEST_RECONCILIATION_ENABLED: "0",
        ALAYA_CONFLICT_DETECTION_ENABLED: "0",
        ALAYA_GARDEN_PROVIDER_KIND: "local_heuristics",
        ALAYA_RECALL_AUTH_HEADER: "Bearer secret-token",
        ALAYA_EXP_SIGNED_URL: "https://example.invalid/model?signature=secret"
      },
      runtime: { nodeVersion: "v24.0.0", platform: "linux", arch: "x64" }
    });

    expect(LONGMEMEVAL_RUN_PROVENANCE_FILENAME).toBe("longmemeval-run-provenance.json");
    expect(provenance.execution).toEqual({
      protocol: "sequential",
      concurrency: 1,
      offset: 0,
      limit: null,
      evaluated_count: 1
    });
    expect(provenance.recall_config.conf_slice_compatibility).toBe(true);
    expect(provenance.seed_capabilities).toEqual({ facet_tags_enabled: true });
    expect(provenance.code).toEqual({
      commit_sha7: "05d98df",
      gate_sha256: "d".repeat(64),
      worktree_state_sha256: "1".repeat(64)
    });
    expect(provenance.extraction_cache).toMatchObject({
      extraction_model: "cached-model",
      provider_url: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      archive_url: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      system_prompt_sha256: "b".repeat(64),
      dataset_revision: "a".repeat(64),
      coverage: 1
    });
    expect(provenance.extraction_cache?.manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(provenance.runtime).toEqual({
      node_version: "v24.0.0",
      platform: "linux",
      arch: "x64",
      embedding_mode: "env",
      embedding_provider_kind: "local_onnx",
      embedding_provider_label: "local_onnx:Xenova/test",
      onnx_threads: 2,
      onnx_model_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      paired_env: {
        ALAYA_EXP_ANSWERS_WITH_CAP: "3",
        ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0",
        ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE: "1",
        ALAYA_LOCAL_ONNX_THREADS: "2",
        OFFICIAL_API_GARDEN_MODEL: "cached-model",
        ALAYA_RECALL_ANSWERS_WITH: "1",
        ALAYA_RECALL_FACET_TAGS: "1",
        ALAYA_RECALL_COVERAGE_SELECTOR: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        ALAYA_INGEST_RECONCILIATION_ENABLED: "0",
        ALAYA_CONFLICT_DETECTION_ENABLED: "0",
        ALAYA_GARDEN_PROVIDER_KIND: "local_heuristics"
      }
    });
    expect(provenance.runtime.paired_env).not.toHaveProperty("ALAYA_RECALL_AUTH_HEADER");
    expect(provenance.runtime.paired_env).not.toHaveProperty("ALAYA_EXP_SIGNED_URL");
    expect(provenance.question_manifest).toMatchObject({
      schema_version: 1,
      variant: "longmemeval_s",
      dataset_sha256: "a".repeat(64),
      target_count: 1,
      selected_id_digest: manifest.selected_id_digest
    });
    expect(provenance.question_manifest?.file_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const sidecar = await buildLongMemEvalRunProvenanceSidecar({
      opts: {
        variant: "longmemeval_s",
        historyRoot: root,
        questionManifest: manifestPath,
        extractionCacheRoot,
        embeddingMode: "env",
        embeddingProviderKind: "local_onnx"
      },
      evaluatedCount: 1,
      commitSha7: "05d98df",
      embeddingProviderLabel: "local_onnx:Xenova/test",
      env: {
        ALAYA_BENCH_GATE_SHA256: "d".repeat(64),
        ALAYA_BENCH_WORKTREE_STATE_SHA256: "1".repeat(64),
        ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: "on",
        ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0",
        ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE: "1",
        OFFICIAL_API_GARDEN_MODEL: "cached-model",
        ALAYA_LOCAL_ONNX_THREADS: "2",
        ALAYA_LOCAL_EMBEDDING_CACHE_DIR: modelCacheRoot,
        ALAYA_EXP_ANSWERS_WITH_CAP: "3",
        ALAYA_RECALL_ANSWERS_WITH: "1",
        ALAYA_RECALL_FACET_TAGS: "1",
        ALAYA_RECALL_COVERAGE_SELECTOR: "https://example.invalid/select?signature=secret",
        ALAYA_INGEST_RECONCILIATION_ENABLED: "0",
        ALAYA_CONFLICT_DETECTION_ENABLED: "0",
        ALAYA_GARDEN_PROVIDER_KIND: "local_heuristics"
      },
      runtime: { nodeVersion: "v24.0.0", platform: "linux", arch: "x64" }
    });
    expect(sidecar.filename).toBe(LONGMEMEVAL_RUN_PROVENANCE_FILENAME);
    expect(JSON.parse(sidecar.contents)).toEqual(provenance);
  });

  it("rejects symbolic links in the local ONNX artifact tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "lme-onnx-symlink-"));
    roots.push(root);
    const modelRoot = join(root, "models", "Xenova", "test");
    await mkdir(modelRoot, { recursive: true });
    await writeFile(join(root, "outside"), "secret", "utf8");
    await symlink(join(root, "outside"), join(modelRoot, "model.onnx"));

    await expect(resolveLocalOnnxArtifactSha256("local_onnx:Xenova/test", {
      ALAYA_LOCAL_EMBEDDING_CACHE_DIR: join(root, "models")
    })).rejects.toThrow(/artifact tree/u);
  });

  it("rejects model traversal and a symlinked model root", async () => {
    const root = await mkdtemp(join(tmpdir(), "lme-onnx-root-symlink-"));
    roots.push(root);
    const cacheRoot = join(root, "models");
    const outside = join(root, "outside");
    await mkdir(cacheRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "model.onnx"), "model", "utf8");
    await symlink(outside, join(cacheRoot, "linked"), "dir");

    await expect(resolveLocalOnnxArtifactSha256("local_onnx:../outside", {
      ALAYA_LOCAL_EMBEDDING_CACHE_DIR: cacheRoot
    })).rejects.toThrow(/cache root/u);
    await expect(resolveLocalOnnxArtifactSha256("local_onnx:linked", {
      ALAYA_LOCAL_EMBEDDING_CACHE_DIR: cacheRoot
    })).rejects.toThrow(/artifact tree/u);
  });
});
