import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, SoulInterpretationRequestSchema,
  SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { prepareNativeSourceRecordsSnapshot, readVerifiedNativeSourceSnapshot,
  sealNativeSourceRecordsSnapshotCopy } from
  "../../../runs/snapshot/source-records/native.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { syntheticGeminiBody } from "../../runs/semantic-proposal/gemini-response-evidence.test-support.js";
import { interpretedQueryRaw } from "../query-producer-fixture.js";
import { runSemanticChainLauncher } from "../../../runs/semantic-chain/launch.js";
import { readChainArtifact, SemanticChainPlanSchema, withSemanticChainDaemon } from "../../../runs/semantic-chain/contract.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { publishSourceSemanticSnapshot, readNativeSourcePublicationReport } from
  "../../../runs/snapshot/source-records/publish.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { preflightSourceSemanticInteractive } from
  "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from
  "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { setExtractionCredentialFixture } from "../extraction-fill/fixture.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("rereads a frozen source after complete abstained H without inventing an initial H or C", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-unqualified-parent-")); roots.push(root);
  let snapshotPath = join(root, "original.sqlite");
  const recoveryRoot = join(root, "recovery");
  const commonBody = "Mira completed the Atlas export.\nMira used Parquet for the Atlas export.\n";
  const originalSources = [
    { source_id: "opaque-a", source_version: "1", title: "Export note",
      content_bytes: commonBody, source_observed_at: "2026-09-20T12:00:00.000Z",
      recorded_at: "2026-09-21T09:00:00.000Z" },
    ...Array.from({ length: 9 }, (_, index) => ({ source_id: `decoy-${index + 1}`, source_version: "1",
      title: `Decoy ${index + 1}`, content_bytes: commonBody,
      source_observed_at: "2026-09-20T12:00:00.000Z",
      recorded_at: `2026-09-21T09:00:${String(index + 1).padStart(2, "0")}.000Z` })),
    { source_id: "warm-outsider", source_version: "1", title: "Older export note",
      content_bytes: commonBody, source_observed_at: "2026-09-20T12:00:00.000Z",
      recorded_at: "2026-09-21T09:00:10.000Z" }
  ];
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "native-daemon"),
    workspaceId: "unqualified-parent", runId: "unqualified-parent", producerCommit: "0".repeat(40),
    sources: originalSources });
  const initialRecords = readVerifiedNativeSourceSnapshot(snapshotPath).records;
  const byNativeOrder = [...initialRecords].sort((a, b) => a.record.identity.localeCompare(b.record.identity));
  const source = byNativeOrder[0]!, warmSource = byNativeOrder.at(-1)!;
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-3.1-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-3.1-low-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://generativelanguage.googleapis.com");
  setExtractionCredentialFixture();
  const warmCache = join(root, "warm-cache"); mkdirSync(warmCache);
  const warmOptions = { variant: "native_source_snapshot" as const,
    nativeSourcePopulation: { name: "unqualified-parent", snapshotPath }, cacheRoot: warmCache,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const warmInspection = await inspectExtractionAuthority({ ...warmOptions, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  expect(warmInspection.missingKeys).toHaveLength(1);
  const warmPreflight = await preflightSourceSemanticInteractive({ ...warmOptions,
    preflightKeys: warmInspection.missingKeys, preflightOutputTokenCap: 16_384,
    geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
  const warmReceipt = createExtractionAuthorityReceipt({ action: "sample",
    sampleScope: createExtractionSampleScope(warmInspection.missingKeys, warmInspection),
    sourcePreflight: warmPreflight, observation: warmInspection.observation, inspection: warmInspection,
    maxConcurrency: 1, outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5,
      maximumInputTokensPerAttempt: warmPreflight.maximum_input_tokens_per_attempt } });
  const warmReceiptPath = join(root, "warm-authority.json");
  writeExtractionAuthorityReceipt(warmReceiptPath, warmReceipt);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    const request = parseSourceSemanticRequest(JSON.parse(prompt));
    const assertion = request.source_request.source_assertions[0]!;
    const raw = JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
      content: { roots: [{ act: "assertion", expression: { kind: "content_ref", key: "event" } }],
        entities: [{ form: "entity", key: "entity", semantic_key: "entity",
          mentions: [{ assertion_id: assertion.assertion_id, text: assertion.text }] }],
        nodes: [{ kind: "statement", key: "event", predicate: { kind: "explicit", reading: "record",
          support: { assertion_id: assertion.assertion_id, text: assertion.text } },
          arguments: [{ role: "theme", target: { kind: "entity_ref", key: "entity" } }],
          qualifications: [] }], gaps: [] } });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: raw }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  }));
  expect((await runExtractionFill({ ...warmOptions, authorityReceiptPath: warmReceiptPath,
    concurrency: 1 })).newlyExtracted).toBe(1);
  const seedSnapshotPath = snapshotPath;
  const warmSnapshotPath = join(root, "warm-native.sqlite");
  const warmPublished = await publishSourceSemanticSnapshot({ snapshotPath: warmSnapshotPath,
    dataDirRoot: join(root, "warm-publication-daemon"), recordedAt: "2026-09-25T00:00:00.000Z",
    workspaceId: "unqualified-parent", runId: "unqualified-parent", producerCommit: "0".repeat(40),
    populations: [{ name: "unqualified-parent", nativeSnapshotPath: seedSnapshotPath,
      model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", cacheRoots: [warmCache],
      publicationAssociations: [{ source_id: warmSource.source_id, source_version: "1",
        generation_key: warmPreflight.ready_requests[0]!.key,
        request_digest: warmPreflight.ready_requests[0]!.requestSha256 }] }] });
  expect(warmPublished.sources.find(row => row.source_id === warmSource.source_id)).toMatchObject({
    source_interpretation: "interpreted", publication: "published", interpretation_id: expect.any(String) });
  sealNativeSourceRecordsSnapshotCopy(seedSnapshotPath, warmSnapshotPath);
  snapshotPath = warmSnapshotPath;
  const question = "Which file format did Mira use for the Atlas export?";
  const qWorkset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3",
    kind: "query", model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1",
    provider_url: "https://generativelanguage.googleapis.com", items: [{ original_query: question }] });
  const qRaw = interpretedQueryRaw({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: [{ kind: "statement", key: "export", predicate: "use",
      arguments: [{ role: "format", target: { kind: "free", key: "answer", return: true }, excerpt: "file format" },
        { role: "export", target: { kind: "named", key: "export", excerpt: "Atlas export" }, excerpt: "Atlas export" }] }] }], gaps: [] });
  const qCache = join(root, "q-cache"); mkdirSync(qCache);
  const qExtractor = { extract: async () => ({ rawJson: qRaw, responseMetadata: { finishReason: "STOP" },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    responseBody: syntheticGeminiBody(qRaw, "STOP", { inputTokens: 10, outputTokens: 20, totalTokens: 30 }) }) };
  const qConfig = { providerUrl: "https://generativelanguage.googleapis.com", model: "gemini-3.1-flash-lite",
    requestProfile: "gemini-3.1-minimal-v1" as const, apiKey: "fixture" };
  const freezePath = join(root, "freeze.json");
  writeFileSync(freezePath, JSON.stringify({ native_snapshot_path: snapshotPath, population: "unqualified-parent",
    source_model: "gemini-3.1-flash-lite", source_request_profile: "gemini-3.1-low-v1",
    source_cache_root: join(root, "h-cache"), recorded_at: "2026-09-25T00:00:00.000Z",
    producer_commit: "0".repeat(40), allowance: { total_work_units: 4_000_000_000,
      total_memory_bytes: 30_000_000_000, read_work_units: 10_000_000, read_memory_bytes: 100_000_000,
      max_input_bytes_per_read: 100_000_000, max_read_admissions: 256, max_effects: 32 }, chain: {
      implementation_revision: readCurrentExtractionAuthorityRevision(),
      interpretation_clock: "2026-09-25T00:00:00.000Z", workspace_id: "unqualified-parent", run_id: "unqualified-parent",
      query_workset: qWorkset, query_cache_root: qCache, correspondence_cache_root: join(root, "c-cache"),
      max_output_tokens: 16_384, correspondence_generation: { model: "gemini-3.1-flash-lite",
        request_profile: "gemini-3.1-low-v1", provider_url: "https://generativelanguage.googleapis.com",
        max_output_tokens: 16_384 }, discovery_page_cap: 1,
      source_preview_extents: initialRecords.map((row) => ({ source_id: row.source_id,
        source_version: row.source_version, record_id: row.record.identity,
        byte_extent: row.source_id === source.source_id
          ? Buffer.byteLength("Mira completed the Atlas export.\n") : 1 })),
      correspondence_pair_cap: 1, access_policy: "canonical-v1",
      budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 200_000_000,
        page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 },
      authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1_000_000 } }));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await runSemanticChainLauncher(["recover-declare-initial-q", "--config", freezePath,
    "--root", recoveryRoot])).toBe(0);
  const qAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(qWorkset, qCache, 16_384, 1),
    inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 });
  await executeSemanticProposalFill({ workset: qWorkset, cacheRoot: qCache, authority: qAuthority,
    config: qConfig, extractor: qExtractor });
  expect(await runSemanticChainLauncher(["recover-freeze", "--config", freezePath, "--root", recoveryRoot])).toBe(0);
  const frozen = readChainArtifact(join(recoveryRoot, "recovery-window.json")) as {
    window: { source_id: string }[]; selected_missing_keys: string[]; window_open: boolean };
  expect(frozen.window).toHaveLength(10);
  expect(frozen.window.some(row => row.source_id === warmSource.source_id)).toBe(false);
  expect(frozen.window_open).toBe(true);
  expect(frozen.selected_missing_keys).toEqual([warmPreflight.ready_requests[0]!.key]);

  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-3.1-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-3.1-low-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://generativelanguage.googleapis.com");
  const hCache = join(root, "h-cache"); mkdirSync(hCache);
  const options = { variant: "native_source_snapshot" as const,
    nativeSourcePopulation: { name: "unqualified-parent", snapshotPath }, cacheRoot: hCache,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  const preflight = await preflightSourceSemanticInteractive({ ...options,
    preflightKeys: inspection.missingKeys, preflightOutputTokenCap: 16_384,
    geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
  const receipt = createExtractionAuthorityReceipt({ action: "sample",
    sampleScope: createExtractionSampleScope(inspection.missingKeys, inspection),
    sourcePreflight: preflight, observation: inspection.observation, inspection,
    maxConcurrency: 1, outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const receiptPath = join(root, "h-authority.json"), preflightPath = join(root, "h-preflight.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  writeFileSync(preflightPath, JSON.stringify(preflight));
  setExtractionCredentialFixture();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
    const raw = JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "abstained" } });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: raw }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  }));
  const filled = await runExtractionFill({ ...options, authorityReceiptPath: receiptPath, concurrency: 1 });
  expect(filled.newlyExtracted).toBe(1);
  expect(await runSemanticChainLauncher(["recover-publish-initial", "--root", recoveryRoot,
    "--source-preflight", preflightPath, "--source-cache-root", hCache])).toBe(0);
  expect(readChainArtifact(join(recoveryRoot, "initial-qualified.json"))).toMatchObject({
    published_selected_count: 0, descriptor_export: [] });
  const qualified = readChainArtifact(join(recoveryRoot, "initial-qualified.json")) as {
    snapshot_path: string; snapshot_sha256: string };
  const qualifiedReport = readNativeSourcePublicationReport(qualified.snapshot_path, snapshotPath);
  expect(qualifiedReport.sources.find(row => row.source_id === warmSource.source_id)).toMatchObject({
    source_interpretation: "copied_uninspected", publication: "not_attempted" });
  const initialPlan = SemanticChainPlanSchema.parse(readChainArtifact(join(recoveryRoot, "initial-chain", "prepare.json")));
  const initialQuery = initialPlan.queries[0]!;
  if (initialQuery.status !== "ready") throw new Error("fixture Q must be admitted");
  await withSemanticChainDaemon({ ...initialPlan.config, snapshot_path: qualified.snapshot_path,
    snapshot_sha256: qualified.snapshot_sha256 }, recoveryRoot, async (daemon) => {
    const warmReason = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient,
      "soul.interpretation", SoulInterpretationRequestSchema.parse({ operation: "reason",
        accepts_unreviewed_conditional_results: true, original_query: question,
        query_semantics: initialQuery.query_semantics,
        source_interpretation_id: warmPublished.sources.find(row => row.source_id === warmSource.source_id)!.interpretation_id,
        budget: initialPlan.config.budget, output_byte_limit: initialPlan.config.output_byte_limit,
        authorized_scopes: initialPlan.config.authorized_scopes })));
    expect(warmReason.operation).toBe("reason");
    if (warmReason.operation !== "reason") return;
    expect(warmReason.result?.outcome).toMatchObject({ status: "preparation_required", missing: "semantic_correspondence" });
    expect(warmReason.interpretation).toBeDefined();
  });
  expect(await runSemanticChainLauncher(["recover-prepare-initial-c", "--root", recoveryRoot])).toBe(0);
  expect(readChainArtifact(join(recoveryRoot, "initial-correspondence-binding.json"))).toMatchObject({
    workset_identity: null, source_interpretation_ids: [] });
  expect(await runSemanticChainLauncher(["recover-reason-initial", "--root", recoveryRoot])).toBe(0);
  expect(readChainArtifact(join(recoveryRoot, "initial-reason.json"))).toMatchObject({
    status: "not_executed_no_qualified_h", results: [] });
  expect(readChainArtifact(join(recoveryRoot, "source-nomination.json"))).toMatchObject({
    source_id: source.source_id, nomination: "frozen_window_after_unbound_reason" });
  expect(await runSemanticChainLauncher(["recover-prepare-q-review", "--root", recoveryRoot])).toBe(0);
  const qChild = parseSemanticProposalWorkset(JSON.parse(readFileSync(join(recoveryRoot,
    "query-review-workset.json"), "utf8")));
  const qChildCache = join(recoveryRoot, "query-review-cache"); mkdirSync(qChildCache);
  const qChildAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(qChild, qChildCache, 16_384, 1),
    inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 });
  await executeSemanticProposalFill({ workset: qChild, cacheRoot: qChildCache,
    authority: qChildAuthority, config: qConfig, extractor: qExtractor });
  expect(await runSemanticChainLauncher(["recover-settle-q-review", "--root", recoveryRoot])).toBe(0);
  expect(await runSemanticChainLauncher(["recover-prepare-source", "--root", recoveryRoot])).toBe(0);
  expect(await runSemanticChainLauncher(["recover-prepare-h-revision", "--root", recoveryRoot])).toBe(0);
  expect(readChainArtifact(join(recoveryRoot, "source-revision.json"))).toMatchObject({
    source_id: source.source_id, parent_key: preflight.ready_requests[0]?.key,
    parent_response_sha256: expect.any(String), child_key: expect.any(String) });
  const revision = readChainArtifact(join(recoveryRoot, "source-revision.json")) as {
    child_key: string; generation_path: string };
  const childCache = join(root, "child-h-cache"); mkdirSync(childCache);
  const childOptions = { ...options, cacheRoot: childCache,
    openSemantics: JSON.parse(readFileSync(revision.generation_path, "utf8")) };
  const childInspection = await inspectExtractionAuthority({ ...childOptions, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  expect(childInspection.missingKeys).toEqual([revision.child_key]);
  const childPreflight = await preflightSourceSemanticInteractive({ ...childOptions,
    preflightKeys: childInspection.missingKeys, preflightOutputTokenCap: 16_384,
    geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
  const childReceipt = createExtractionAuthorityReceipt({ action: "sample",
    sampleScope: createExtractionSampleScope(childInspection.missingKeys, childInspection),
    sourcePreflight: childPreflight, observation: childInspection.observation, inspection: childInspection,
    maxConcurrency: 1, outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5,
      maximumInputTokensPerAttempt: childPreflight.maximum_input_tokens_per_attempt } });
  const childReceiptPath = join(root, "child-h-authority.json"), childPreflightPath = join(root, "child-h-preflight.json");
  writeExtractionAuthorityReceipt(childReceiptPath, childReceipt);
  writeFileSync(childPreflightPath, JSON.stringify(childPreflight));
  expect(await runSemanticChainLauncher(["recover-publish-final", "--root", recoveryRoot,
    "--source-preflight", childPreflightPath, "--source-cache-root", childCache])).toBe(2);
  expect((await runExtractionFill({ ...childOptions, authorityReceiptPath: childReceiptPath,
    concurrency: 1 })).newlyExtracted).toBe(1);
  expect(await runSemanticChainLauncher(["recover-publish-final", "--root", recoveryRoot,
    "--source-preflight", childPreflightPath, "--source-cache-root", childCache])).toBe(0);
  expect(readChainArtifact(join(recoveryRoot, "final-qualified.json"))).toMatchObject({
    source_outcome: "initial_reused_terminal_child", snapshot_path: qualified.snapshot_path,
    snapshot_sha256: qualified.snapshot_sha256, descriptor_export: [] });
  expect(await runSemanticChainLauncher(["recover-prepare-final-c", "--root", recoveryRoot])).toBe(0);
  expect(await runSemanticChainLauncher(["recover-final-deliver", "--root", recoveryRoot])).toBe(0);
  expect(readChainArtifact(join(recoveryRoot, "first-exposure.json"))).toMatchObject({
    delivered_count: expect.any(Number), replay_path: expect.any(String) });
});
