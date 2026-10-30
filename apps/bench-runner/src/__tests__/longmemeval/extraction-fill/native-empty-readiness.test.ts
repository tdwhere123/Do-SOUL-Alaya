import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { SOURCE_SEMANTIC_CACHE_CONTRACT, SOURCE_SEMANTIC_PACKET_CONTRACT } from "@do-soul/alaya-protocol";
import { prepareNativeSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { preflightSourceSemanticInteractive, parseSourceSemanticInteractivePreflight } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { inspectExtractionFillPreparation, inspectFillWindow } from "../../../runs/extraction/fill/fill-preparation.js";
import { buildFillManifest } from "../../../runs/extraction/fill/manifest/fill-manifest.js";
import { acquireExtractionCacheWriteLease } from "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import { readExtractionCacheManifest, writeExtractionCacheManifest, extractionAdmissionGenerationSha256 }
  from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { cacheFilePath, writeCachedExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { computeExtractionRawJsonSha256 } from "../../../runs/extraction/content-closure.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, SOURCE_SEMANTIC_BATCH_PRODUCER_ID }
  from "../../../runs/extraction/request-artifact.js";
const fetch = vi.spyOn(globalThis, "fetch");
afterAll(() => { fetch.mockRestore(); boundary.restore(); expect(boundary.violations).toEqual([]); });

it("reconstructs retained empty-source readiness without rewriting or readmitting the historical shard", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-empty-readiness-"));
  const cacheRoot = join(root, "cache"), snapshotPath = join(root, "source.sqlite");
  mkdirSync(cacheRoot);
  try {
    await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "daemon"),
      workspaceId: "empty", runId: "empty", producerCommit: "0".repeat(40), sources: [{
        source_id: "empty", source_version: "1", title: "Empty source", content_bytes: "",
        source_observed_at: "2026-09-20T00:00:00.000Z", recorded_at: "2026-09-21T00:00:00.000Z"
      }] });
    vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "step-3.5-flash-2603");
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "step-3.5-2603-low-json-schema-v1");
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://api.stepfun.com/step_plan/v1");
    const options = { cacheRoot, variant: "native_source_snapshot" as const,
      nativeSourcePopulation: { name: "empty", snapshotPath }, sourcePacking: "complete-source" as const,
      openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
    const cold = await preflightSourceSemanticInteractive(options);
    expect(cold).toMatchObject({ selected_requests: 0, cached_requests: 0, deterministic_requests: 1, provider_calls: 0 });
    const prepared = await inspectExtractionFillPreparation(options, cacheRoot, undefined);
    const lease = acquireExtractionCacheWriteLease(cacheRoot);
    try {
      writeExtractionCacheManifest(cacheRoot, buildFillManifest({ config: prepared.config,
        variant: prepared.variant, existingManifest: undefined, datasetRevision: prepared.datasetRevision,
        status: "in_progress", windowOffset: prepared.windowOffset, windowLimit: prepared.windowLimit,
        completion: prepared.completion }));
      // Install closed historical fixture bytes, not a new deterministic producer result.
      const line = cold.ready_requests[0]!;
      writeCachedExtraction(cacheRoot, line.key, {
        model: prepared.config.model, request_profile: prepared.config.requestProfile,
        cache_key: line.key, raw_json: "", extracted_at: "2026-09-21T00:00:00.000Z",
        admission_identity: { generation_sha256: extractionAdmissionGenerationSha256(readExtractionCacheManifest(cacheRoot)!),
          request_key: line.key, raw_json_sha256: computeExtractionRawJsonSha256("") },
        source_semantic: { contract: SOURCE_SEMANTIC_CACHE_CONTRACT, source_binding: "unbound",
          interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT, kind: "deterministic_empty",
          completion: "no_eligible_source", source_corpus: "", producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID, line }
      });
      const completion = inspectFillWindow(cacheRoot, prepared.config, prepared.distinctExtractionTurns,
        prepared.nativeSourceRecords, prepared.datasetRevision);
      writeExtractionCacheManifest(cacheRoot, buildFillManifest({ config: prepared.config,
        variant: prepared.variant, existingManifest: undefined, datasetRevision: prepared.datasetRevision,
        status: "in_progress", windowOffset: prepared.windowOffset, windowLimit: prepared.windowLimit, completion }));
    } finally { lease.release(); }
    const path = cacheFilePath(cacheRoot, cold.ready_requests[0]!.key), before = readFileSync(path);
    const warm = await preflightSourceSemanticInteractive(options);
    expect(warm).toMatchObject({ selected_requests: 0, cached_requests: 1, deterministic_requests: 0, provider_calls: 0 });
    expect(warm.ready_requests).toEqual(cold.ready_requests);
    expect(parseSourceSemanticInteractivePreflight(JSON.parse(JSON.stringify(warm)))).toEqual(warm);
    expect(readFileSync(path)).toEqual(before);
    expect(warm.execution_authorized).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
