import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { preflightSourceSemanticInteractive } from
  "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { prepareSourcePublicationAssociations } from "../../../runs/snapshot/source-records/prepare-associations.js";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { readCompleteRetainedSourceResponse } from "../../../runs/extraction/cache/source-interactive-binding.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { setExtractionCredentialFixture } from "../extraction-fill/fixture.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { interpretedQueryRaw } from "../query-producer-fixture.js";
import { SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, SoulInterpretationRequestSchema,
  SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { syntheticGeminiBody } from "../../runs/semantic-proposal/gemini-response-evidence.test-support.js";
import { runSemanticChainLauncher } from "../../../runs/semantic-chain/launch.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { readChainArtifact, SemanticChainPlanSchema, withSemanticChainDaemon } from "../../../runs/semantic-chain/contract.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { prepareNativeSourceRecordsSnapshot, readVerifiedNativeSourceSnapshot }
  from "../../../runs/snapshot/source-records/native.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { censusNativeSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, prepareSourceSemanticRequestLine,
  sourceSemanticArtifactPreparations, parseExtractionOpenSemanticsGeneration } from "../../../runs/extraction/request-artifact.js";

const roots: string[] = [];
const generationTask = { contract: "source-semantic-generation-task-v1" as const,
  context: "complete_original_source" as const, original_query: "Which file format did Mira use for the Atlas export?",
  responsibility: { kind: "original_query_task" as const, other_meaning: "unassessed" as const } };
const taskGeneration = { ...EXTRACTION_OPEN_SEMANTICS_GENERATION, generation_task: generationTask };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("reports an available empty native source as complete under a tuple-bound preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-empty-source-")); roots.push(root);
  const snapshotPath = join(root, "empty.sqlite");
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "install"),
    workspaceId: "empty-source", runId: "empty-source", producerCommit: "0".repeat(40),
    sources: [{ source_id: "source-empty", source_version: "1", title: "Empty source",
      content_bytes: "", source_observed_at: "2026-09-20T12:00:00.000Z",
      recorded_at: "2026-09-21T09:00:00.000Z" }] });
  const record = readVerifiedNativeSourceSnapshot(snapshotPath).records[0]!;
  const rawPath = join(root, "raw.sqlite");
  const report = await publishSourceSemanticSnapshot({ snapshotPath: rawPath,
    dataDirRoot: join(root, "publish"), recordedAt: "2026-09-25T00:00:00.000Z",
    workspaceId: "empty-source", runId: "empty-source", producerCommit: "0".repeat(40),
    populations: [{ name: "empty-source", nativeSnapshotPath: snapshotPath,
      model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1" }] });
  const plan = await prepareSemanticChain({ snapshot_path: rawPath, snapshot_sha256: report.db_sha256,
    implementation_revision: readCurrentExtractionAuthorityRevision(),
    interpretation_clock: "2026-09-25T00:00:00.000Z", workspace_id: "empty-source", run_id: "empty-source",
    query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
      model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1",
      provider_url: "https://generativelanguage.googleapis.com",
      items: [{ original_query: "What is in the source?" }] }), query_cache_root: join(root, "no-q"),
    correspondence_cache_root: join(root, "no-c"), max_output_tokens: 16_384,
    discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "canonical-v1",
    source_preview_extents: [{ source_id: record.source_id, source_version: record.source_version,
      record_id: record.record.identity, byte_extent: 1 }],
    budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 200_000_000,
      page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 },
    authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1_000_000 }, join(root, "plan"));
  const observed = plan.queries[0];
  expect(observed).toMatchObject({ discovery_pages: 1, discovery_trace: [{ access: {
    source_candidates: [expect.objectContaining({ source_id: "source-empty", read_bytes: 0,
      body_bytes: 0, complete: true })], unvisited_sources: false } }] });
});

it("stops a selected Gemini source sample after its first failed key on dispatch and reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-source-sample-failure-")); roots.push(root);
  const snapshotPath = join(root, "sources.sqlite"), cacheRoot = join(root, "cache");
  mkdirSync(cacheRoot);
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "daemon"),
    workspaceId: "sample-failure", runId: "sample-failure", producerCommit: "0".repeat(40),
    sources: ["One source sentence.\n", "Another source sentence.\n"].map((content, index) => ({
      source_id: `source-${index}`, source_version: "1", title: `Source ${index}`,
      content_bytes: content, source_observed_at: "2026-09-20T12:00:00.000Z",
      recorded_at: "2026-09-21T09:00:00.000Z" })) });
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-3.1-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-3.1-low-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://generativelanguage.googleapis.com");
  const options = { variant: "native_source_snapshot" as const,
    nativeSourcePopulation: { name: "sample-failure", snapshotPath }, cacheRoot,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  expect(inspection.missingKeys).toHaveLength(2);
  const preflight = await preflightSourceSemanticInteractive({ ...options,
    preflightKeys: inspection.missingKeys, preflightOutputTokenCap: 16_384,
    geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
  const receipt = createExtractionAuthorityReceipt({ action: "sample",
    sampleScope: createExtractionSampleScope(inspection.missingKeys, inspection),
    sourcePreflight: preflight, observation: inspection.observation, inspection,
    maxConcurrency: 1, outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
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

it("preserves both source clocks, revisions and every document newline through native installation", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-source-snapshot-"));
  roots.push(root);
  const snapshotPath = join(root, "initial.sqlite");
  const records = [
    { source_id: "source-7df0", source_version: "1", title: "Export note 1",
      content_bytes: "Mira completed the Atlas export.\nMira used Parquet for the Atlas export.\n",
      source_observed_at: "2026-09-20T12:00:00.000Z", recorded_at: "2026-09-21T09:00:00.000Z" },
    { source_id: "source-b326", source_version: "1", title: "Export note 2",
      content_bytes: "Mira used CSV for the Beacon export.\n",
      source_observed_at: "2026-09-20T12:00:00.000Z", recorded_at: "2026-09-21T09:00:01.000Z" }
  ] as const;
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "daemon"),
    workspaceId: "native-source-test", runId: "native-source-test", producerCommit: "0".repeat(40), sources: records });
  const verified = readVerifiedNativeSourceSnapshot(snapshotPath);
  expect(verified.records.map(({ source_id, source_version, title, content_bytes, source_observed_at, recorded_at }) =>
    ({ source_id, source_version, title, content_bytes, source_observed_at, recorded_at }))).toEqual(records);
  expect(verified.records[0]?.record.event_time).toBe(records[0].source_observed_at);
  expect(verified.records[1]?.record.recorded_at).toBe(records[1].recorded_at);
  const census = censusNativeSourceRecords({ population: "native-records", snapshotPath });
  for (const [index, source] of census.records.entries()) {
    expect(source.content_bytes).toBe(records[index]?.content_bytes);
    const [prepared] = sourceSemanticArtifactPreparations(source.content_bytes, "complete-source",
      EXTRACTION_OPEN_SEMANTICS_GENERATION);
    if (prepared?.status !== "ready") throw new Error("native source must have one ready H request");
    const line = prepareSourceSemanticRequestLine(prepared.semantic, [], {
      model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" });
    expect(JSON.parse(line.userPrompt).source_digest).toBe(source.corpus_digest);
    const end = prepared.semantic.source_request.assertion_locations.at(-1)?.source_utf8_span[1];
    expect(end).toBe(Buffer.byteLength(source.content_bytes) - 1);
    expect(source.content_bytes.slice(end)).toBe("\n");
    if (index === 0) {
      const locations = prepared.semantic.source_request.assertion_locations;
      expect(locations).toHaveLength(2);
      expect(source.content_bytes.slice(locations[0]!.source_utf8_span[1], locations[1]!.source_utf8_span[0]))
        .toBe("\n");
      expect(prepared.semantic.source_request.source_assertions[1]?.text).toBe("Mira used Parquet for the Atlas export.");
    }
  }
  const published = await publishSourceSemanticSnapshot({ snapshotPath: join(root, "qualified.sqlite"),
    dataDirRoot: join(root, "qualified-daemon"), recordedAt: "2026-09-25T00:00:00.000Z",
    workspaceId: "native-source-test", runId: "native-source-test", producerCommit: "0".repeat(40),
    populations: [{ name: "native-records", nativeSnapshotPath: snapshotPath,
      model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" }] });
  expect(published.admitted_count).toBe(2);
  expect(published.published_count).toBe(0);
  expect(published.sources.map(row => ({ source_id: row.source_id, record_id: row.record_id,
    recorded_at: row.source_record?.recorded_at, event_time: row.source_record?.event_time }))).toEqual(
    verified.records.map(row => ({ source_id: row.source_id, record_id: row.record.identity,
      recorded_at: row.recorded_at, event_time: row.source_observed_at })));

  const question = "Which file format did Mira use for the Atlas export?";
  const queryCacheRoot = join(root, "query-cache"); mkdirSync(queryCacheRoot);
  const queryWorkset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3",
    kind: "query", model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1",
    provider_url: "https://generativelanguage.googleapis.com", items: [{ original_query: question,
      approved_fixed_context: { context_id: "original-export-format", notes:
        "Use the retained export notes. Atlas and Beacon name different exports. If the Atlas format is not supported by the available notes, keep it unknown." } }] });
  const queryRaw = interpretedQueryRaw({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: [{ kind: "statement", key: "export", predicate: "use",
      arguments: [{ role: "format", target: { kind: "free", key: "answer", return: true }, excerpt: "file format" },
        { role: "export", target: { kind: "named", key: "export", excerpt: "Atlas export" }, excerpt: "Atlas export" }] }] }], gaps: [] });
  const recoveryRoot = join(root, "recovery");
  const recoveryConfigPath = join(root, "recovery-config.json");
  writeFileSync(recoveryConfigPath, JSON.stringify({ native_snapshot_path: snapshotPath, population: "native-records",
    open_semantics: taskGeneration,
    source_model: "gemini-3.1-flash-lite", source_request_profile: "gemini-3.1-low-v1",
    source_cache_root: join(root, "source-cache"), recorded_at: "2026-09-25T00:00:00.000Z",
    producer_commit: "0".repeat(40), allowance: { total_work_units: 4_000_000_000,
      total_memory_bytes: 30_000_000_000, read_work_units: 10_000_000,
      read_memory_bytes: 100_000_000, max_input_bytes_per_read: 100_000_000,
      max_read_admissions: 256, max_effects: 32 }, chain: {
      implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-25T00:00:00.000Z",
      workspace_id: "native-source-test", run_id: "native-source-test",
      query_workset: queryWorkset, query_cache_root: queryCacheRoot,
      correspondence_cache_root: join(root, "correspondence-cache"), max_output_tokens: 16_384,
      correspondence_generation: { model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-low-v1",
        provider_url: "https://generativelanguage.googleapis.com", max_output_tokens: 16_384 },
      discovery_page_cap: 1, source_preview_extents: verified.records.map((row, index) => ({
        source_id: row.source_id, source_version: row.source_version, record_id: row.record.identity,
        byte_extent: index === 0 ? Buffer.byteLength("Mira completed the Atlas export.\n") : Buffer.byteLength(row.content_bytes)
      })),
      correspondence_pair_cap: 2, access_policy: "query-conditioned-v1",
      budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 200_000_000,
        page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 },
      authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1_000_000 } }));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await runSemanticChainLauncher(["recover-declare-initial-q", "--config", recoveryConfigPath,
    "--root", recoveryRoot])).toBe(0);
  const queryAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(queryWorkset, queryCacheRoot, 16_384, 1),
    inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 });
  await executeSemanticProposalFill({ workset: queryWorkset, cacheRoot: queryCacheRoot, authority: queryAuthority,
    config: { providerUrl: "https://generativelanguage.googleapis.com", model: "gemini-3.1-flash-lite",
      requestProfile: "gemini-3.1-minimal-v1", apiKey: "fixture" },
    extractor: { extract: async () => ({ rawJson: queryRaw, responseMetadata: { finishReason: "STOP" },
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      responseBody: syntheticGeminiBody(queryRaw, "STOP", { inputTokens: 10, outputTokens: 20, totalTokens: 30 }) }) } });
  expect(await runSemanticChainLauncher(["recover-freeze", "--config", recoveryConfigPath, "--root", recoveryRoot])).toBe(0);
  const frozen = readChainArtifact(join(recoveryRoot, "recovery-window.json")) as {
    window: { source_id: string; read_bytes: number; body_bytes: number; complete: boolean }[];
    selected_missing_keys: string[]; initial_access: { trace: { source_offset: number } };
    initial_chain_root: string; raw_snapshot_sha256: string };
  expect(frozen.window).toHaveLength(2);
  expect(frozen.selected_missing_keys).toHaveLength(2);
  expect(frozen.initial_access.trace.source_offset).toBe(0);
  expect(frozen.window.find(row => row.source_id === "source-7df0")).toMatchObject({
    read_bytes: Buffer.byteLength("Mira completed the Atlas export.\n"), complete: false });
  expect(frozen.window.find(row => row.source_id === "source-b326")).toMatchObject({
    read_bytes: Buffer.byteLength(records[1].content_bytes), complete: true });
  expect(await runSemanticChainLauncher(["recover-freeze", "--config", recoveryConfigPath, "--root", recoveryRoot])).toBe(0);

  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-3.1-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-3.1-low-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://generativelanguage.googleapis.com");
  const cacheRoot = join(root, "source-cache"); mkdirSync(cacheRoot);
  const options = { variant: "native_source_snapshot" as const,
    nativeSourcePopulation: { name: "native-records", snapshotPath }, cacheRoot,
    sourcePacking: "complete-source" as const, openSemantics: taskGeneration };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  expect(inspection.observation.dataset).toMatchObject({ variant: "native_source_snapshot",
    revisionSha256: census.dataset_sha256, windowTurnOccurrences: 2,
    windowUniqueCacheKeys: 2 });
  const preflight = await preflightSourceSemanticInteractive({ ...options,
    preflightKeys: inspection.missingKeys, preflightOutputTokenCap: 16_384,
    geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
  expect(preflight).toMatchObject({ selected_requests: 2, source_occurrences: 2,
    max_output_tokens: 16_384, output_token_field: "maxOutputTokens",
    maximum_attempts_per_key: 1 });
  expect(preflight.ready_requests.map(row => row.key)).toEqual(inspection.missingKeys);
  for (const row of preflight.ready_requests) {
    const request = parseSourceSemanticRequest(JSON.parse(row.userPrompt));
    expect(request.source_request.generation_task).toEqual(generationTask);
    expect(records.map(record => record.content_bytes)).toContain(request.source_request.original_source);
  }
  expect(preflight.ready_requests.some(row => row.userPrompt.includes("Mira used Parquet for the Atlas export."))).toBe(true);
  expect(preflight.planned_requests.every(row => row.wire_sha256?.length === 64)).toBe(true);
  const sampleScope = createExtractionSampleScope(inspection.missingKeys, inspection);
  const receipt = createExtractionAuthorityReceipt({ action: "sample", sampleScope,
    sourcePreflight: preflight, observation: inspection.observation, inspection,
    maxConcurrency: 1, outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  expect(receipt).toMatchObject({ source_preflight_digest: expect.any(String),
    limits: { maximum_attempts: 2, max_concurrency: 1 }, observation: { dataset: {
      variant: "native_source_snapshot" } } });
  const receiptPath = join(root, "source-authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  setExtractionCredentialFixture();
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(String(url)).pathname).toMatch(/:streamGenerateContent$/u);
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    const request = parseSourceSemanticRequest(JSON.parse(prompt));
    const assertion = request.source_request.source_assertions[0]!;
    const response = JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
      content: { roots: [{ act: "assertion", expression: { kind: "content_ref", key: "completion" } }],
        entities: [{ form: "entity", key: "r0", semantic_key: "r0",
          mentions: [{ assertion_id: assertion.assertion_id, text: assertion.text }] }],
        nodes: [{ kind: "statement", key: "completion",
          predicate: { kind: "explicit", reading: "record", support: {
            assertion_id: assertion.assertion_id, text: assertion.text } },
          arguments: [{ role: "theme", target: { kind: "entity_ref", key: "r0" } }], qualifications: [] }], gaps: [] } });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: response }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const filled = await runExtractionFill({ ...options, authorityReceiptPath: receiptPath, concurrency: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(filled.newlyExtracted).toBe(2);
  for (const row of preflight.ready_requests) {
    const cached = inspectCachedSourceSemantic(cacheRoot, row.key, "gemini-3.1-flash-lite", "gemini-3.1-low-v1");
    if (cached.status !== "hit") throw new Error("task-bearing native cache required");
    expect(cached.admitted.draft?.generation_task).toEqual(generationTask);
    expect(cached.admitted.interpretation?.generation_task).toEqual(generationTask);
  }
  expect(preflight.ready_requests.every(row =>
    inspectCachedSourceSemantic(cacheRoot, row.key, "gemini-3.1-flash-lite", "gemini-3.1-low-v1").status === "hit"))
    .toBe(true);
  const preflightPath = join(root, "source-preflight.json");
  writeFileSync(preflightPath, JSON.stringify(preflight));
  const associations = await prepareSourcePublicationAssociations({ name: "native-records", nativeSnapshotPath: snapshotPath,
    model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", openSemantics: taskGeneration },
  [{ cacheRoot, retainedPreparationPath: preflightPath }], join(root, "source-associations.json"));
  expect(associations.sources.every(row => row.status === "associated")).toBe(true);
  expect(readCompleteRetainedSourceResponse({ cacheRoot, preflight, line: preflight.ready_requests[0]! }))
    .toContain("source-semantic-proposal-v8");
  const qualified = await publishSourceSemanticSnapshot({ snapshotPath: join(root, "with-h.sqlite"),
    dataDirRoot: join(root, "with-h-daemon"), recordedAt: "2026-09-25T00:00:00.000Z",
    workspaceId: "native-source-test", runId: "native-source-test", producerCommit: "0".repeat(40),
    populations: [{ name: "native-records", nativeSnapshotPath: snapshotPath,
      model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1",
      openSemantics: taskGeneration,
      cacheRoots: [cacheRoot], publicationAssociations: associations.publicationAssociations }] });
  expect(qualified.published_count).toBe(2);
  expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
    "--source-preflight", preflightPath, "--source-cache-root", cacheRoot])).toBe(0);
  const initialQualified = readChainArtifact(join(recoveryRoot, "initial-qualified.json")) as {
    snapshot_path: string; snapshot_sha256: string; published_selected_count: number;
    descriptor_export: { source_id: string; record_id: string; descriptor: { source_interpretation_id: string } }[] };
  expect(initialQualified.published_selected_count).toBe(2);
  expect(initialQualified.descriptor_export.map(row => [row.source_id, row.record_id])).toEqual(
    verified.records.map(row => [row.source_id, row.record.identity]));
  expect(initialQualified.snapshot_sha256).not.toBe(frozen.raw_snapshot_sha256);
  const initialPlan = SemanticChainPlanSchema.parse(readChainArtifact(join(frozen.initial_chain_root, "prepare.json")));
  const initialQuery = initialPlan.queries[0];
  if (initialQuery?.status !== "ready") throw new Error("original Q was not admitted");
  const qualifiedPlan = await prepareSemanticChain({ ...initialPlan.config, snapshot_path: initialQualified.snapshot_path,
    snapshot_sha256: initialQualified.snapshot_sha256 }, join(root, "task-discovery"));
  const qualifiedQuery = qualifiedPlan.queries[0];
  if (qualifiedQuery?.status !== "ready") throw new Error("qualified task discovery required");
  expect(qualifiedQuery.descriptors).not.toHaveLength(0);
  expect(qualifiedQuery.descriptors.every(descriptor => descriptor.generation_task?.responsibility.kind === "original_query_task"))
    .toBe(true);
  for (const descriptor of qualifiedQuery.descriptors) {
    expect(descriptor.generation_task).not.toHaveProperty("original_query");
    expect(descriptor.interpretation?.generation_task).toEqual(generationTask);
  }
  await withSemanticChainDaemon({ ...initialPlan.config, snapshot_path: initialQualified.snapshot_path,
    snapshot_sha256: initialQualified.snapshot_sha256 }, recoveryRoot, async daemon => {
    const missingC = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ operation: "reason", original_query: initialQuery.original_query,
        query_semantics: initialQuery.query_semantics,
        source_interpretation_id: initialQualified.descriptor_export[0]!.descriptor.source_interpretation_id,
        accepts_unreviewed_conditional_results: true, budget: initialPlan.config.budget,
        output_byte_limit: initialPlan.config.output_byte_limit, authorized_scopes: initialPlan.config.authorized_scopes })));
    expect(missingC.operation).toBe("reason");
    if (missingC.operation !== "reason") return;
    expect(missingC.result?.outcome).toEqual({ status: "preparation_required", missing: "semantic_correspondence" });
    expect(missingC.result?.attention).toMatchObject({ kind: "preparation", missing: "semantic_correspondence",
      source_id: records[0].source_id, observation: "not_executed" });
    expect(missingC.work.native_work).toBeGreaterThan(0);
  });
  expect(await runSemanticChainLauncher(["recover-prepare-initial-c", "--root", recoveryRoot])).toBe(0);
  const cWorkset = parseSemanticProposalWorkset(JSON.parse(readFileSync(join(recoveryRoot, "initial-correspondence-workset.json"), "utf8")));
  expect(cWorkset.items).toHaveLength(2);
  const cCacheRoot = join(root, "correspondence-cache"); mkdirSync(cCacheRoot);
  const cAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(cWorkset, cCacheRoot, 16_384, 1),
    inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 });
  const cFilled = await executeSemanticProposalFill({ workset: cWorkset, cacheRoot: cCacheRoot, authority: cAuthority,
    config: { providerUrl: "https://generativelanguage.googleapis.com", model: "gemini-3.1-flash-lite",
      requestProfile: "gemini-3.1-low-v1", apiKey: "fixture" },
    extractor: { extract: async ({ userPrompt }) => {
      const request = JSON.parse(userPrompt) as { catalog: { query_endpoints: { handle: string }[] } };
      const rawJson = JSON.stringify({ contract: "source-semantic-correspondence-response-v4",
        outcome: { status: "interpreted" }, semantic_correspondence: {
          contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
          assessments: request.catalog.query_endpoints.map(row => ({ query: row.handle, status: "unresolved",
            query_excerpt: "file format", explanation: "No source equivalent for this query endpoint is established." }))
        } });
      return { rawJson, responseMetadata: { finishReason: "STOP" },
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        responseBody: syntheticGeminiBody(rawJson, "STOP", { inputTokens: 10, outputTokens: 20, totalTokens: 30 }) };
    } } });
  expect(cFilled.interpreted).toBe(2);
  expect(await runSemanticChainLauncher(["recover-reason-initial", "--root", recoveryRoot])).toBe(0);
  const initialReason = readChainArtifact(join(recoveryRoot, "initial-reason.json")) as {
    results: { status: string; response?: { operation: string; result?: { binding_results?: unknown[];
      attention?: { source_id: string; entries: { obligation: string; state: string }[] } } } }[] };
  expect(initialReason.results).toHaveLength(2);
  expect(initialReason.results.every(row => row.status === "reasoned" && row.response?.operation === "reason" &&
    row.response.result?.binding_results?.length === 0)).toBe(true);
  expect(initialReason.results.map(row => row.response?.result?.attention?.source_id)).toEqual(records.map(row => row.source_id));
  expect(initialReason.results[0]?.response?.result?.attention?.entries.some(row =>
    row.obligation === "predicate" && row.state === "correspondence_missing")).toBe(true);
  expect(await runSemanticChainLauncher(["recover-prepare-q-review", "--root", recoveryRoot])).toBe(0);
  const qReviewWorkset = parseSemanticProposalWorkset(JSON.parse(readFileSync(join(recoveryRoot, "query-review-workset.json"), "utf8")));
  const qReviewCache = join(recoveryRoot, "query-review-cache"); mkdirSync(qReviewCache);
  const qReviewAuthority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(qReviewWorkset, qReviewCache, 16_384, 1),
    inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 });
  const qReviewFilled = await executeSemanticProposalFill({ workset: qReviewWorkset, cacheRoot: qReviewCache,
    authority: qReviewAuthority, config: { providerUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1", apiKey: "fixture" },
    extractor: { extract: async () => ({ rawJson: queryRaw, responseMetadata: { finishReason: "STOP" },
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      responseBody: syntheticGeminiBody(queryRaw, "STOP", { inputTokens: 10, outputTokens: 20, totalTokens: 30 }) }) } });
  expect(qReviewFilled.interpreted).toBe(1);
  expect(await runSemanticChainLauncher(["recover-settle-q-review", "--root", recoveryRoot])).toBe(0);
  expect(readChainArtifact(join(recoveryRoot, "query-review.json"))).toMatchObject({
    active_query_origin: "admitted_child", changed: false });
  expect(await runSemanticChainLauncher(["recover-prepare-source", "--root", recoveryRoot])).toBe(0);
  const freshSource = readChainArtifact(join(recoveryRoot, "recovery-source-read.json")) as {
    source_id: string; initial_read_bytes: number; initial_body_bytes: number;
    response: { catalog: { assertions: { segments: { text: string }[] }[] }; work: { native_work: number } } };
  expect(freshSource.source_id).toBe(records[0].source_id);
  expect(freshSource.initial_read_bytes).toBeLessThan(freshSource.initial_body_bytes);
  expect(freshSource.response.catalog.assertions.map(row => row.segments.map(part => part.text).join("")))
    .toContain("Mira used Parquet for the Atlas export.");
  expect(freshSource.response.work.native_work).toBeGreaterThan(0);
  expect(await runSemanticChainLauncher(["recover-prepare-h-revision", "--root", recoveryRoot])).toBe(0);
  expect(readChainArtifact(join(recoveryRoot, "source-revision.json"))).toMatchObject({
    source_id: records[0].source_id, parent_key: expect.any(String), child_key: expect.any(String),
    parent_response_sha256: expect.any(String) });
  const revision = readChainArtifact(join(recoveryRoot, "source-revision.json")) as { child_key: string; parent_key: string };
  const revisedGeneration = parseExtractionOpenSemanticsGeneration(JSON.parse(readFileSync(
    join(recoveryRoot, "source-revision-generation.json"), "utf8")));
  const childCacheRoot = join(root, "source-child-cache"); mkdirSync(childCacheRoot);
  const childOptions = { ...options, cacheRoot: childCacheRoot, openSemantics: revisedGeneration };
  const childInspection = await inspectExtractionAuthority({ ...childOptions, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  expect(childInspection.missingKeys).toContain(revision.child_key);
  const childPreflight = await preflightSourceSemanticInteractive({ ...childOptions,
    preflightKeys: [revision.child_key], preflightOutputTokenCap: 16_384,
    geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
  const childScope = createExtractionSampleScope([revision.child_key], childInspection);
  const childReceipt = createExtractionAuthorityReceipt({ action: "sample", sampleScope: childScope,
    sourcePreflight: childPreflight, observation: childInspection.observation, inspection: childInspection,
    maxConcurrency: 1, outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5,
      maximumInputTokensPerAttempt: childPreflight.maximum_input_tokens_per_attempt } });
  const childReceiptPath = join(root, "source-child-authority.json");
  writeExtractionAuthorityReceipt(childReceiptPath, childReceipt);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    const request = parseSourceSemanticRequest(JSON.parse(prompt));
    expect(request.source_request.revision?.revision_number).toBe(1);
    const assertion = request.source_request.source_assertions.find(row => row.text.includes("Parquet"))!;
    const quote = (text: string) => ({ assertion_id: assertion.assertion_id, text });
    const response = JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
      content: { roots: [{ act: "assertion", expression: { kind: "content_ref", key: "event" } }],
        entities: ["Mira", "Parquet", "Atlas"].map((value, index) => ({ form: "selection",
          key: ["actor", "format", "export"][index], selection: quote(value) })),
        nodes: [{ kind: "statement", key: "event", predicate: { kind: "explicit", reading: "use",
          support: quote("used") }, arguments: ["actor", "format", "export"].map(role => ({ role,
          target: { kind: "entity_ref", key: role } })), qualifications: [] }], gaps: [] } });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: response }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  }));
  const childFilled = await runExtractionFill({ ...childOptions, authorityReceiptPath: childReceiptPath, concurrency: 1 });
  expect(childFilled.newlyExtracted).toBe(1);
  const childPreflightPath = join(root, "source-child-preflight.json");
  writeFileSync(childPreflightPath, JSON.stringify(childPreflight));
  const selectedNative = verified.records.find(row => row.source_id === records[0].source_id)!;
  const mixed = await prepareSourcePublicationAssociations({ name: "native-records", nativeSnapshotPath: snapshotPath,
    model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1",
    openSemantics: taskGeneration,
    activeRevision: { kind: "native", source_id: records[0].source_id, source_version: records[0].source_version,
      record_id: selectedNative.record.identity, key: revision.child_key, generation: revisedGeneration } }, [
      { cacheRoot, retainedPreparationPath: preflightPath },
      { cacheRoot: childCacheRoot, retainedPreparationPath: childPreflightPath }
    ], join(root, "mixed-associations.json"));
  expect(mixed.sources.every(row => row.status === "associated")).toBe(true);
  expect(mixed.publicationAssociations.find(row => row.source_id === records[0].source_id))
    .toMatchObject({ generation_key: revision.child_key });
  expect(await runSemanticChainLauncher(["recover-publish-final", "--root", recoveryRoot,
    "--source-preflight", childPreflightPath, "--source-cache-root", childCacheRoot])).toBe(0);
  const finalQualified = readChainArtifact(join(recoveryRoot, "final-qualified.json")) as {
    snapshot_path: string; snapshot_sha256: string; descriptor_export: { source_id: string;
      generation_key: string; descriptor: { source_interpretation_id: string } }[] };
  expect(finalQualified.descriptor_export).toHaveLength(2);
  expect(finalQualified.descriptor_export.find(row => row.source_id === records[0].source_id))
    .toMatchObject({ generation_key: revision.child_key });
  expect(finalQualified.descriptor_export.find(row => row.source_id === records[1].source_id))
    .toMatchObject({ generation_key: frozen.selected_missing_keys.find(key => key !== revision.parent_key) });
  expect(finalQualified.snapshot_sha256).not.toBe(initialQualified.snapshot_sha256);
  expect(await runSemanticChainLauncher(["recover-prepare-final-c", "--root", recoveryRoot])).toBe(0);
  const finalC = parseSemanticProposalWorkset(JSON.parse(readFileSync(join(recoveryRoot,
    "final-correspondence-workset.json"), "utf8")));
  const initialKeys = materializeSemanticProposalLines(cWorkset, 16_384).map(row => row.key);
  const finalKeys = materializeSemanticProposalLines(finalC, 16_384).map(row => row.key);
  expect(finalKeys[0]).not.toBe(initialKeys[0]);
  expect(finalKeys[1]).toBe(initialKeys[1]);
  const finalNewC = parseSemanticProposalWorkset(JSON.parse(readFileSync(join(recoveryRoot,
    "final-correspondence-new-workset.json"), "utf8")));
  expect(materializeSemanticProposalLines(finalNewC, 16_384).map(row => row.key)).toEqual([finalKeys[0]]);
  const finalCacheRoot = join(recoveryRoot, "final-correspondence-cache"); mkdirSync(finalCacheRoot);
  const finalCAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(finalNewC, finalCacheRoot, 16_384, 1),
    inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 });
  const finalCFilled = await executeSemanticProposalFill({ workset: finalNewC, cacheRoot: finalCacheRoot,
    authority: finalCAuthority, config: { providerUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", apiKey: "fixture" },
    extractor: { extract: async ({ userPrompt }) => {
      const request = JSON.parse(userPrompt) as { catalog: { query_endpoints: { handle: string }[] } };
      const rawJson = JSON.stringify({ contract: "source-semantic-correspondence-response-v4",
        outcome: { status: "interpreted" }, semantic_correspondence: {
          contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
          assessments: request.catalog.query_endpoints.map(row => ({ query: row.handle, status: "unresolved",
            query_excerpt: "file format", explanation: "No equivalent is established by this mock response." })) } });
      return { rawJson, responseMetadata: { finishReason: "STOP" },
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        responseBody: syntheticGeminiBody(rawJson, "STOP", { inputTokens: 10, outputTokens: 20, totalTokens: 30 }) };
    } } });
  expect(finalCFilled.newly_admitted).toBe(1);
  expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(0);
  const firstExposure = readChainArtifact(join(recoveryRoot, "first-exposure.json")) as {
    replay_path: string; replay_identity: string; stage_identity: string };
  expect(firstExposure).toMatchObject({
    contract: "source-semantic-recovery-first-exposure-v1", delivered_count: expect.any(Number) });
  rmSync(firstExposure.replay_path);
  rmSync(join(recoveryRoot, "first-exposure.json"));
  expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(0);
  expect(readChainArtifact(join(recoveryRoot, "first-exposure.json"))).toMatchObject({
    replay_identity: firstExposure.replay_identity, stage_identity: firstExposure.stage_identity });
});
