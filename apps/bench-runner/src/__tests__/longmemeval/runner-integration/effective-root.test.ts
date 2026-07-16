import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  computeSystemPromptSha256,
  writeExtractionCacheManifest
} from "../../../longmemeval/extraction-cache-manifest.js";
import { prepareCrossQuestionRun } from "../../../longmemeval/crossquestion-run.js";
import { prepareMultiturnRun } from "../../../longmemeval/multiturn-run.js";
import { LongMemEvalDiagnosticsSpool } from
  "../../../longmemeval/diagnostics/spool.js";
import { prepareLongMemEvalRun } from
  "../../../longmemeval/runner/prepare-context.js";
import { buildLongMemEvalRunProvenance } from
  "../../../longmemeval/provenance/run.js";
import { selectionContractIdentity } from "../../../longmemeval/selection/contract.js";
import {
  buildRunnerQuestions,
  createRunnerFixture,
  stubOfflineExtractionEnv
} from "./fixture.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "tier-one-effective-root-"));
  stubOfflineExtractionEnv();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("Tier 1 effective extraction root", () => {
  it.each(["multiturn", "crossquestion"] as const)(
    "binds the %s producer and provenance to one isolated v3 root",
    async (surface) => {
      const fixture = await createRunnerFixture({
        root: tmpRoot,
        label: surface,
        variant: "longmemeval_s",
        questions: buildRunnerQuestions(`q-${surface}-`, 1)
      });
      writeCurrentCacheManifest(fixture.extractionCacheRoot, fixture.datasetSha256);
      vi.stubEnv("ALAYA_BENCH_EXTRACTION_CACHE_ROOT", fixture.extractionCacheRoot);
      const context = await prepareSurface(surface, fixture);
      const provenance = await provenanceFor(context, fixture.datasetSha256);

      expect(context.opts.extractionCacheRoot).toBe(fixture.extractionCacheRoot);
      expect(provenance.extraction_cache).toMatchObject({
        schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
        dataset_revision: fixture.datasetSha256,
        request_profile: "provider-default-v1"
      });
    }
  );

  it.each(["recall", "snapshot"] as const)(
    "fails the %s entrypoint closed on a cache miss despite live env opt-in",
    async (surface) => {
      const questions = buildRunnerQuestions(`q-${surface}-`, 1);
      const fixture = await createRunnerFixture({
        root: tmpRoot,
        label: `cache-only-${surface}`,
        variant: "longmemeval_s",
        questions
      });
      writeCurrentCacheManifest(fixture.extractionCacheRoot, fixture.datasetSha256);
      const fetchSpy = stubCredentialledLiveExtractionEnv();
      const spool = await LongMemEvalDiagnosticsSpool.create();

      try {
        await expect(prepareLongMemEvalRun({
          variant: fixture.variant,
          limit: 1,
          historyRoot: fixture.historyRoot,
          dataDir: fixture.dataDir,
          pinnedMetaRoot: fixture.pinnedMetaRoot,
          extractionCacheRoot: fixture.extractionCacheRoot,
          embeddingMode: "disabled",
          ...(surface === "snapshot"
            ? { snapshotOut: join(tmpRoot, "snapshot.db") }
            : {})
        }, undefined, spool)).rejects.toThrow(/cache covers only part/u);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        await spool.dispose();
      }
    }
  );

  it.each(["multiturn", "crossquestion"] as const)(
    "fails the %s entrypoint at run start on a cache miss despite live env opt-in",
    async (surface) => {
      const fixture = await createRunnerFixture({
        root: tmpRoot,
        label: `cache-only-${surface}`,
        variant: "longmemeval_s",
        questions: buildRunnerQuestions(`q-${surface}-`, 1)
      });
      writeCurrentCacheManifest(fixture.extractionCacheRoot, fixture.datasetSha256);
      vi.stubEnv("ALAYA_BENCH_EXTRACTION_CACHE_ROOT", fixture.extractionCacheRoot);
      const fetchSpy = stubCredentialledLiveExtractionEnv();

      await expect(prepareSurface(surface, fixture)).rejects.toThrow(
        /cache covers only part/u
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );
});

async function prepareSurface(
  surface: "multiturn" | "crossquestion",
  fixture: Awaited<ReturnType<typeof createRunnerFixture>>
) {
  const opts = {
    variant: fixture.variant,
    limit: 1,
    historyRoot: fixture.historyRoot,
    dataDir: fixture.dataDir,
    pinnedMetaRoot: fixture.pinnedMetaRoot
  };
  return surface === "multiturn"
    ? prepareMultiturnRun({ ...opts, rounds: 2 })
    : prepareCrossQuestionRun(opts);
}

async function provenanceFor(
  context: Awaited<ReturnType<typeof prepareSurface>>,
  datasetSha256: string
) {
  return buildLongMemEvalRunProvenance({
    opts: context.opts,
    evaluatedCount: context.window.length,
    commitSha7: context.commitSha7,
    embeddingProviderLabel: context.embeddingProviderLabel,
    env: process.env,
    runtime: { nodeVersion: "v24.0.0", platform: "linux", arch: "x64" },
    computeExecutedDistIdentity: async () => ({
      algorithm: "sha256-reachable-path-file-sha256-v1",
      sha256: "e".repeat(64),
      file_count: 1
    }),
    datasetSha256,
    selection: selectionContractIdentity(context.selectionContract)
  });
}

function writeCurrentCacheManifest(cacheRoot: string, datasetSha256: string): void {
  writeExtractionCacheManifest(cacheRoot, {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: "test-extraction-model",
    model_family: "test-extraction-model",
    request_profile: "provider-default-v1",
    provider_url: "https://provider.invalid/v1",
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: datasetSha256,
    requested_turns: 0,
    cached_turns: 0,
    coverage: 1,
    storage: "git-tracked",
    built_at: "2026-07-16T00:00:00.000Z",
    builder: "test"
  });
}

function stubCredentialledLiveExtractionEnv() {
  vi.stubEnv("ALAYA_BENCH_ALLOW_LIVE_EXTRACTION", "1");
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:TEST_GARDEN_API_KEY");
  vi.stubEnv("TEST_GARDEN_API_KEY", "test-secret-never-used");
  vi.stubEnv("ALAYA_SEED_EXTRACTION_DIAG_DIR", join(tmpRoot, "diagnostics"));
  const fetchSpy = vi.fn(() => Promise.reject(new Error("network must not run")));
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}
