import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { setExtractionCredentialFixture } from "../extraction-fill/fixture.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-cache/workset.js";
import { prepareSemanticChain } from "../../../runs/recall-measurement/prepare.js";
import { prepareNativeSourceRecordsSnapshot, readVerifiedNativeSourceSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { censusNativeSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, prepareSourceSemanticRequestLine,
  sourceSemanticArtifactPreparations } from "../../../runs/extraction/request-artifact.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await settleActiveBenchDaemonTasks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reports an available empty native source as complete under a tuple-bound preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-empty-source-")); roots.push(root);
  const snapshotPath = join(root, "empty.sqlite");
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "install"),
    workspaceId: "empty-source", runId: "empty-source", producerCommit: "0".repeat(40),
    sources: [{ source_id: "source-empty", source_version: "1", title: "Empty source", content_bytes: "",
      source_observed_at: "2026-09-20T12:00:00.000Z", recorded_at: "2026-09-21T09:00:00.000Z" }] });
  const record = readVerifiedNativeSourceSnapshot(snapshotPath).records[0]!;
  const rawPath = join(root, "raw.sqlite");
  const report = await publishSourceSemanticSnapshot({ snapshotPath: rawPath, dataDirRoot: join(root, "publish"),
    recordedAt: "2026-09-25T00:00:00.000Z", workspaceId: "empty-source", runId: "empty-source", producerCommit: "0".repeat(40),
    populations: [{ name: "empty-source", nativeSnapshotPath: snapshotPath,
      model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1" }] });
  const plan = await prepareSemanticChain({ snapshot_path: rawPath, snapshot_sha256: report.db_sha256,
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-25T00:00:00.000Z",
    workspace_id: "empty-source", run_id: "empty-source",
    query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
      model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1", provider_url: "https://generativelanguage.googleapis.com",
      items: [{ original_query: "What is in the source?" }] }), query_cache_root: join(root, "no-q"),
    correspondence_cache_root: join(root, "no-c"), max_output_tokens: 16_384,
    discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "canonical-v1",
    source_preview_extents: [{ source_id: record.source_id, source_version: record.source_version,
      record_id: record.record.identity, byte_extent: 1 }],
    budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 200_000_000,
      page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 },
    authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1_000_000 }, join(root, "plan"));
  expect(plan.queries[0]).toMatchObject({ discovery_pages: 1, discovery_trace: [{ access: {
    source_candidates: [expect.objectContaining({ source_id: "source-empty", read_bytes: 0, body_bytes: 0, complete: true })],
    unvisited_sources: false } }] });
});

it("stops a selected Gemini source sample after its first failed key on dispatch and reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-source-sample-failure-")); roots.push(root);
  const snapshotPath = join(root, "sources.sqlite"), cacheRoot = join(root, "cache"); mkdirSync(cacheRoot);
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "daemon"),
    workspaceId: "sample-failure", runId: "sample-failure", producerCommit: "0".repeat(40),
    sources: ["One source sentence.\n", "Another source sentence.\n"].map((content, index) => ({
      source_id: `source-${index}`, source_version: "1", title: `Source ${index}`, content_bytes: content,
      source_observed_at: "2026-09-20T12:00:00.000Z", recorded_at: "2026-09-21T09:00:00.000Z" })) });
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-3.1-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-3.1-low-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://generativelanguage.googleapis.com");
  const options = { variant: "native_source_snapshot" as const,
    nativeSourcePopulation: { name: "sample-failure", snapshotPath }, cacheRoot,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample", revision: readCurrentExtractionAuthorityRevision() });
  expect(inspection.missingKeys).toHaveLength(2);
  const preflight = await preflightSourceSemanticInteractive({ ...options, preflightKeys: inspection.missingKeys,
    preflightOutputTokenCap: 16_384, geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
  const receipt = createExtractionAuthorityReceipt({ action: "sample", sampleScope: createExtractionSampleScope(inspection.missingKeys, inspection),
    sourcePreflight: preflight, observation: inspection.observation, inspection, maxConcurrency: 1,
    outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const receiptPath = join(root, "receipt.json"); writeExtractionAuthorityReceipt(receiptPath, receipt);
  setExtractionCredentialFixture();
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ error: { message: "failed" } }, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(runExtractionFill({ ...options, authorityReceiptPath: receiptPath, concurrency: 1 }))
    .rejects.toThrow(/selected interactive source fill stopped/u);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(runExtractionFill({ ...options, authorityReceiptPath: receiptPath, concurrency: 1 }))
    .rejects.toThrow(/selected interactive source fill stopped/u);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("preserves source clocks, revisions and document newlines through native installation and reopened publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-source-snapshot-")); roots.push(root);
  const snapshotPath = join(root, "initial.sqlite");
  const records = [
    { source_id: "source-7df0", source_version: "1", title: "Export note 1",
      content_bytes: "Mira completed the Atlas export.\nMira used Parquet for the Atlas export.\n",
      source_observed_at: "2026-09-20T12:00:00.000Z", recorded_at: "2026-09-21T09:00:00.000Z" },
    { source_id: "source-b326", source_version: "2", title: "Export note 2", content_bytes: "Mira used CSV for the Beacon export.\n",
      source_observed_at: "2026-09-20T12:00:00.000Z", recorded_at: "2026-09-21T09:00:01.000Z" }
  ] as const;
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "daemon"),
    workspaceId: "native-source-test", runId: "native-source-test", producerCommit: "0".repeat(40), sources: records });
  const verified = readVerifiedNativeSourceSnapshot(snapshotPath);
  expect(verified.records.map(({ source_id, source_version, title, content_bytes, source_observed_at, recorded_at }) =>
    ({ source_id, source_version, title, content_bytes, source_observed_at, recorded_at }))).toEqual(records);
  const census = censusNativeSourceRecords({ population: "native-records", snapshotPath });
  for (const [index, source] of census.records.entries()) {
    expect(source.content_bytes).toBe(records[index]?.content_bytes);
    const [prepared] = sourceSemanticArtifactPreparations(source.content_bytes, "complete-source", EXTRACTION_OPEN_SEMANTICS_GENERATION);
    if (prepared?.status !== "ready") throw new Error("native source must have one ready H request");
    const line = prepareSourceSemanticRequestLine(prepared.semantic, [], { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" });
    expect(JSON.parse(line.userPrompt).source_digest).toBe(source.corpus_digest);
    const end = prepared.semantic.source_request.assertion_locations.at(-1)?.source_utf8_span[1];
    expect(end).toBe(Buffer.byteLength(source.content_bytes) - 1); expect(source.content_bytes.slice(end)).toBe("\n");
    if (index === 0) {
      const locations = prepared.semantic.source_request.assertion_locations;
      expect(locations).toHaveLength(2);
      expect(source.content_bytes.slice(locations[0]!.source_utf8_span[1], locations[1]!.source_utf8_span[0])).toBe("\n");
      expect(prepared.semantic.source_request.source_assertions[1]?.text).toBe("Mira used Parquet for the Atlas export.");
    }
  }
  const published = await publishSourceSemanticSnapshot({ snapshotPath: join(root, "published.sqlite"), dataDirRoot: join(root, "publication"),
    recordedAt: "2026-09-25T00:00:00.000Z", workspaceId: "native-source-test", runId: "native-source-test", producerCommit: "0".repeat(40),
    populations: [{ name: "native-records", nativeSnapshotPath: snapshotPath, model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" }] });
  expect(published.admitted_count).toBe(2); expect(published.published_count).toBe(0);
  expect(published.sources.map(row => ({ source_id: row.source_id, record_id: row.record_id,
    recorded_at: row.source_record?.recorded_at, event_time: row.source_record?.event_time }))).toEqual(
    verified.records.map(row => ({ source_id: row.source_id, record_id: row.record.identity,
      recorded_at: row.recorded_at, event_time: row.source_observed_at })));
}, 60000);
