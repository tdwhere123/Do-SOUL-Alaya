import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  writeExtractionCacheManifest
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import {
  buildLongMemEvalRunProvenance,
  buildLongMemEvalRunProvenanceSidecar
} from "../../../longmemeval/provenance/run.js";
import {
  createLongMemEvalSelectionContract,
  selectionContractIdentity
} from "../../../longmemeval/selection/contract.js";
import { createStratifiedQuestionManifest } from "../../../longmemeval/selection/question-manifest.js";
import { syntheticExtractionClosure } from "../extraction/extraction-closure-fixture.js";

const EXTRACTION_CLOSURE = syntheticExtractionClosure({
  count: 10,
  model: "cached-model",
  requestProfile: "deepseek-v4-nonthinking-v1",
  seed: "run-provenance"
});

export function registerRunProvenanceRootCleanup(): string[] {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(
      async (root) => await rm(root, { recursive: true, force: true })
    ));
  });
  return roots;
}

export async function createRunProvenanceFixture(roots: string[]) {
  const paths = await createRunProvenancePaths(roots);
  await writeLocalModelArtifacts(paths.modelCacheRoot, paths.crossEncoderCacheRoot);
  const authority = await createQuestionAuthority(paths.manifestPath);
  writeFixtureExtractionManifest(paths.extractionCacheRoot);
  const provenance = await buildLongMemEvalRunProvenance({
    opts: {
      variant: "longmemeval_s",
      historyRoot: paths.root,
      questionManifest: paths.manifestPath,
      extractionCacheRoot: paths.extractionCacheRoot,
      embeddingMode: "env",
      embeddingProviderKind: "local_onnx"
    },
    evaluatedCount: 1,
    commitSha7: "05d98df",
    embeddingProviderLabel: "local_onnx:Xenova/test",
    env: createRunProvenanceEnvironment(paths.modelCacheRoot, paths.crossEncoderCacheRoot),
    runtime: { nodeVersion: "v24.0.0", platform: "linux", arch: "x64" },
    computeExecutedDistIdentity: fakeExecutedDistIdentity,
    datasetSha256: authority.manifest.dataset_sha256,
    selection: authority.selection
  });

  return { ...paths, ...authority, provenance };
}

async function createRunProvenancePaths(roots: string[]) {
  const root = await mkdtemp(join(tmpdir(), "lme-provenance-"));
  roots.push(root);
  return {
    root,
    manifestPath: join(root, "manifest.json"),
    extractionCacheRoot: join(root, "extraction-cache"),
    modelCacheRoot: join(root, "models"),
    crossEncoderCacheRoot: join(root, "cross-models")
  };
}

async function writeLocalModelArtifacts(
  modelCacheRoot: string,
  crossEncoderCacheRoot: string
): Promise<void> {
  await mkdir(join(modelCacheRoot, "Xenova", "test"), { recursive: true });
  await mkdir(join(crossEncoderCacheRoot, "Xenova", "reranker"), { recursive: true });
  await writeFile(join(modelCacheRoot, "Xenova", "test", "config.json"), "model-config", {
    encoding: "utf8",
    flag: "w"
  });
  await writeFile(
    join(crossEncoderCacheRoot, "Xenova", "reranker", "model.onnx"),
    "cross-encoder-model",
    "utf8"
  );
}

async function createQuestionAuthority(manifestPath: string) {
  const selectedQuestions = [{
    question_id: "q-1",
    question_type: "multi-session",
    question: "q",
    answer: "a",
    question_date: "2026-01-01",
    haystack_session_ids: [],
    haystack_dates: [],
    haystack_sessions: [],
    answer_session_ids: []
  }];
  const manifest = createStratifiedQuestionManifest({
    variant: "longmemeval_s",
    datasetSha256: "a".repeat(64),
    questions: selectedQuestions,
    targetCount: 1
  });
  const selection = selectionContractIdentity(createLongMemEvalSelectionContract({
    datasetSha256: manifest.dataset_sha256,
    questions: selectedQuestions
  }));
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  return { manifest, selection };
}

function writeFixtureExtractionManifest(extractionCacheRoot: string): void {
  writeExtractionCacheManifest(extractionCacheRoot, {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: "cached-model",
    model_family: "cached-family",
    request_profile: "deepseek-v4-nonthinking-v1",
    provider_url: "https://provider.invalid/v1",
    system_prompt_sha256: "b".repeat(64),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: "a".repeat(64),
    requested_turns: 10,
    cached_turns: 10,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 1,
    ...EXTRACTION_CLOSURE,
    supplemental_source_receipt: {
      kind: "longmemeval-extraction-supplemental-source",
      receipt_sha256: "d".repeat(64),
      shard_count: 2,
      key_set_sha256: "e".repeat(64),
      physical_provider_url: "https://user:secret@supplement.example/v1?key=hidden",
      physical_model: "deepseek-v4-flash"
    },
    storage: "archive",
    archive_url: "https://cache.invalid/archive.tar.zst",
    archive_sha256: "c".repeat(64),
    built_at: "2026-07-01T00:00:00.000Z",
    builder: "test"
  });
}

export async function buildFixtureRunProvenanceSidecar(
  fixture: Awaited<ReturnType<typeof createRunProvenanceFixture>>
) {
  return await buildLongMemEvalRunProvenanceSidecar({
    opts: {
      variant: "longmemeval_s",
      historyRoot: fixture.root,
      questionManifest: fixture.manifestPath,
      extractionCacheRoot: fixture.extractionCacheRoot,
      embeddingMode: "env",
      embeddingProviderKind: "local_onnx"
    },
    evaluatedCount: 1,
    commitSha7: "05d98df",
    embeddingProviderLabel: "local_onnx:Xenova/test",
    env: createRunProvenanceEnvironment(
      fixture.modelCacheRoot,
      fixture.crossEncoderCacheRoot,
      false
    ),
    runtime: { nodeVersion: "v24.0.0", platform: "linux", arch: "x64" },
    computeExecutedDistIdentity: fakeExecutedDistIdentity,
    datasetSha256: fixture.manifest.dataset_sha256,
    selection: fixture.selection
  });
}

function createRunProvenanceEnvironment(
  modelCacheRoot: string,
  crossEncoderCacheRoot: string,
  includeRedactionInputs = true
): NodeJS.ProcessEnv {
  return {
    ALAYA_BENCH_EXECUTED_DIST_CLOSURE_SHA256: "2".repeat(64),
    ALAYA_BENCH_EXECUTED_DIST_FILE_COUNT: "17",
    ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: "on",
    ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0",
    ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE: "1",
    ALAYA_BENCH_EXTRACTION_MODEL_FAMILY: "cached-family",
    OFFICIAL_API_GARDEN_MODEL: "cached-model",
    ALAYA_LOCAL_ONNX_THREADS: "2",
    ALAYA_LOCAL_EMBEDDING_CACHE_DIR: modelCacheRoot,
    ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true",
    ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR: crossEncoderCacheRoot,
    ALAYA_LOCAL_CROSS_ENCODER_MODEL: "Xenova/reranker",
    ALAYA_EXP_ANSWERS_WITH_CAP: "3",
    ALAYA_RECALL_ANSWERS_WITH: "1",
    ALAYA_RECALL_FACET_TAGS: "1",
    ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP: "2",
    ALAYA_INGEST_RECONCILIATION_ENABLED: "0",
    ALAYA_CONFLICT_DETECTION_ENABLED: "0",
    ALAYA_GARDEN_PROVIDER_KIND: "local_heuristics",
    ...(includeRedactionInputs ? {
      ALAYA_RECALL_AUTH_HEADER: "Bearer secret-token",
      ALAYA_EXP_SIGNED_URL: "https://example.invalid/model?signature=secret"
    } : {})
  };
}

export async function fakeExecutedDistIdentity() {
  return {
    algorithm: "sha256-reachable-path-file-sha256-v1",
    sha256: "2".repeat(64),
    file_count: 17
  } as const;
}

export { EXTRACTION_CLOSURE };
