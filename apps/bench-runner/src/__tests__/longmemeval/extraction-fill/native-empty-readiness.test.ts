import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("provider transport forbidden"); }));
});
import { prepareNativeSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { preflightSourceSemanticInteractive, parseSourceSemanticInteractivePreflight } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { inspectExtractionFillPreparation, inspectFillWindow } from "../../../runs/extraction/fill/fill-preparation.js";
import { buildFillManifest } from "../../../runs/extraction/fill/manifest/fill-manifest.js";
import { acquireExtractionCacheWriteLease } from "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import { writeExtractionCacheManifest } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { writeDeterministicSourceSemanticArtifact } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";

it("regenerates warm empty-source readiness from a sealed native snapshot and persisted deterministic shard", async () => {
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
      writeDeterministicSourceSemanticArtifact({ config: prepared.config, cacheRoot, writeLease: lease,
        line: cold.ready_requests[0]!, sourceCorpus: "" });
      const completion = inspectFillWindow(cacheRoot, prepared.config, prepared.distinctExtractionTurns,
        prepared.nativeSourceRecords, prepared.datasetRevision);
      writeExtractionCacheManifest(cacheRoot, buildFillManifest({ config: prepared.config,
        variant: prepared.variant, existingManifest: undefined, datasetRevision: prepared.datasetRevision,
        status: "in_progress", windowOffset: prepared.windowOffset, windowLimit: prepared.windowLimit, completion }));
    } finally { lease.release(); }
    const warm = await preflightSourceSemanticInteractive(options);
    expect(warm).toMatchObject({ selected_requests: 0, cached_requests: 1, deterministic_requests: 0, provider_calls: 0 });
    expect(warm.ready_requests).toEqual(cold.ready_requests);
    expect(parseSourceSemanticInteractivePreflight(JSON.parse(JSON.stringify(warm)))).toEqual(warm);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
