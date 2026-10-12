import { join } from "node:path";
import { assessmentForTestPairs } from "../../support/semantic-correspondence-assessment.js";
import { cpSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { registerExtractionFillHooks, writeExtractionFillDataset } from "./fixture.js";
import { preflightExtractionBatch } from "../../../runs/extraction/fill/batch-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, parseExtractionOpenSemanticsGeneration } from "../../../runs/extraction/request-artifact.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { prepareSourcePublicationAssociations } from "../../../runs/snapshot/source-records/prepare-associations.js";
import { parseSemanticProposalWorkset, semanticProposalWorksetContract } from "../../../runs/semantic-proposal/workset.js";
import { materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { prepareSemanticProposal, executeSemanticProposalFill } from "../../../runs/semantic-proposal/fill.js";
import { syntheticGeminiBody } from "../../runs/semantic-proposal/gemini-response-evidence.test-support.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { prepareLazyQualificationWindow, replayLazyQualifiedFirstExposure,
  sealLazyQualificationFinal } from "../../../runs/semantic-chain/lazy-qualification.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact,
  writeChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { admitNativeLazyConfig } from "../../../runs/semantic-chain/bind-lazy.js";
import { inspectSemanticChainReplayTarget, replaySemanticChain } from "../../../runs/semantic-chain/replay.js";
import { measureSourceSemanticLibraryResponse } from "../../../runs/measurement/source-semantic-library-measurement.js";
import { SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SoulInterpretationResponseSchema, SourceSemanticAccessReceiptSchema } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
  type SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { interpretedQueryRaw } from "../query-producer-fixture.js";
import { tableCompletedResponse } from "./source-semantic-table-response.test-support.js";
import { setExtractionCredentialFixture } from "./fixture.js";
import { inspectExtractionAuthority } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createFreshRetiredSourceRebuildTargetSelection,
  writeExtractionTargetSelectionReceipt } from "../../../runs/extraction/authority/target-selection/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import type { GeminiBatchLimits, GeminiBatchPlan } from "../../../runs/extraction/fill/batch/contract.js";
import { writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { forkSettledExtractionAttemptLedger, openExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";

const MODEL = "gemini-2.5-flash-lite";
const PROFILE = "gemini-2.5-nonthinking-v1" as const;
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), "longmemeval_s");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function question(contents: readonly string[]) {
  return { question_id: "bounded", question_type: "fixture", question: "What was completed?", answer: "unused",
    question_date: "2026-09-23", haystack_session_ids: contents.map((_, index) => `session-${index}`),
    haystack_dates: contents.map(() => "2023-09-10"),
    haystack_sessions: contents.map(content => [{ role: "user" as const, content }]), answer_session_ids: [] };
}

async function preparedSourceFixture(contents: readonly string[], outputByteLimit = 100000,
  sourceCacheRoot = cacheRoot) {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  await writeDataset([question(contents)]);
  mkdirSync(sourceCacheRoot, { recursive: true });
  const preflight = await preflightExtractionBatch({ variant: "longmemeval_s", cacheRoot: sourceCacheRoot, dataDir, pinnedMetaRoot,
    offset: 0, limit: 1, sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    batch: { operation: "prepare", limits: { maxJobs: 1, maxRequestsPerJob: 64,
      maxFileBytes: 1000000, maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000,
      maxOutputTokens: 4096, maxUsd: 1, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
      deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 } } });
  const preflightPath = join(cacheRoot, "source-preflight.json");
  writeFileSync(preflightPath, JSON.stringify(preflight));
  const published = await publishSourceSemanticSnapshot({ snapshotPath: join(cacheRoot, "starting.sqlite"),
    dataDirRoot: join(cacheRoot, "starting-runtime"), recordedAt: "2026-09-23T00:00:00.000Z",
    producerCommit: "a".repeat(40), workspaceId: "bounded-workspace", runId: "bounded-run",
    populations: [{ name: "fixture", dataDir, pinnedMetaRoot, questionWindow: { offset: 0, limit: 1 },
      model: MODEL, requestProfile: PROFILE }] });
  const workset = parseSemanticProposalWorkset({ contract: semanticProposalWorksetContract(PROFILE),
    provider_url: "https://fixture-provider.invalid", kind: "query", model: MODEL, request_profile: PROFILE,
    items: [{ original_query: "What was completed?" }] });
  const chain = { snapshot_path: published.snapshot_path, snapshot_sha256: published.db_sha256,
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-23T00:00:00.000Z",
    workspace_id: "bounded-workspace", run_id: "bounded-run", query_workset: workset,
    query_cache_root: join(cacheRoot, "query-cache"), correspondence_cache_root: join(cacheRoot, "correspondence-cache"),
    max_output_tokens: 4096, discovery_page_cap: 4, correspondence_pair_cap: 2,
    access_policy: "query-conditioned-v1", budget: { schema_version: 1, work_units: 1000000,
      memory_bytes: 60000000, page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 },
    authorized_scopes: { mode: "unrestricted" }, output_byte_limit: outputByteLimit };
  const bind = async (currentChain = chain, label = "initial") => {
    const initialChainRoot = join(cacheRoot, `initial-${label}`);
    const plan = await prepareSemanticChain(currentChain, initialChainRoot);
    const bound = await admitNativeLazyConfig({ plan, initialChainRoot,
      population: { name: "fixture", dataDir, pinnedMetaRoot, questionWindow: { offset: 0, limit: 1 } },
      sourcePreflightPath: preflightPath, sourceCacheRoot,
      recordedAt: "2026-09-23T00:00:00.000Z", producerCommit: "a".repeat(40) });
    return bound.config;
  };
  return { config: await bind(), published, bind };
}

it("delivers a raw source outside the frozen qualification window after final native reprepare", async () => {
  const contents = [
    ...Array.from({ length: 10 }, (_, index) => `What was completed? I completed item ${index}. ${"details ".repeat(500)}`),
    "A short unrelated note.",
    "Another short unrelated note."
  ];
  // The complete native page includes its access receipt. This cap fits two long
  // selected previews plus a short outsider, while the next long preview does not fit.
  const { config } = await preparedSourceFixture(contents, 17700);
  const root = join(cacheRoot, "raw-outside-stage");
  const window = await prepareLazyQualificationWindow(config, root);
  expect(window.window).toHaveLength(10);
  expect(window.window.map(row => row.record_id)).toEqual(
    window.starting_access.source_candidates.slice(0, 10).map(row => row.record_id));
  expect(window.selected_missing_keys).toHaveLength(10);
  const selected = new Set(window.window.map(row => row.record_id));
  const final = await sealLazyQualificationFinal(root);
  expect(final.final_access?.observed_source_count).toBe(12);
  expect(final.final_access?.source_candidates).toHaveLength(12);
  const first = await replayLazyQualifiedFirstExposure(root);
  expect(first.delivery.outside_delivered).toBeGreaterThan(0);
  const response = SoulInterpretationResponseSchema.parse(first.result.rows[0]?.response);
  if (response.operation !== "recall") throw new Error("native recall required");
  const outside = response.index!.entries.flatMap((entry, index) => entry.target.kind === "source_evidence"
    && !selected.has(entry.target.root_id) ? [{ entry, qualifier: response.slot_qualifiers?.[index] }] : []);
  expect(outside).toHaveLength(first.delivery.outside_delivered);
  expect(outside.every(row => row.qualifier?.evidence_kind === "source_evidence"
    && row.qualifier.selection_basis === "source_access" && row.entry.interpretation_node === undefined)).toBe(true);
  const report = JSON.parse(readFileSync(final.publication_report_path, "utf8"));
  expect(outside.every(row => {
    if (row.entry.target.kind !== "source_evidence") return false;
    const rootId = row.entry.target.root_id;
    return report.sources.some((source: { record_id: string; publication: string }) =>
      source.record_id === rootId && source.publication === "not_attempted");
  })).toBe(true);
  expect(first.result.provider_calls).toBe(0);
  expect(final.source_producer.new_authorized_attempts).toBe(0);
  expect(final.selected_new_associations).toBe(0);
});

it("keeps the durable first delivery fixed when source qualification completes afterward", async () => {
  const { config } = await preparedSourceFixture(["I completed alpha."]);
  const root = join(cacheRoot, "late-qualification-stage");
  const window = await prepareLazyQualificationWindow(config, root);
  expect(window.window).toHaveLength(1);
  expect(window.selected_missing_keys).toHaveLength(1);
  const final = await sealLazyQualificationFinal(root);
  expect(final.selected_new_associations).toBe(0);
  const first = await replayLazyQualifiedFirstExposure(root);
  const firstResponse = SoulInterpretationResponseSchema.parse(first.result.rows[0]?.response);
  if (firstResponse.operation !== "recall") throw new Error("native recall required");
  const initial = { delivery_id: firstResponse.delivery_id, request_identity: firstResponse.request_identity,
    entries: firstResponse.index?.entries, order: firstResponse.order, proofs: firstResponse.proofs ?? [],
    results: firstResponse.results, slot_qualifiers: firstResponse.slot_qualifiers };
  const reservation = readFileSync(join(root, "first-exposure.reserved.json"));
  const commitment = readFileSync(join(root, "first-exposure.json"));
  const frozenWindow = readFileSync(join(root, "window.json"));
  const frozenFinal = readFileSync(join(root, "final.json"));
  const nativeRow = readFileSync(inspectSemanticChainReplayTarget(final.final_chain_root, "retained")
    .rowPaths.get(window.query_key)!);

  setExtractionCredentialFixture();
  const options = { variant: "longmemeval_s" as const, cacheRoot, dataDir, pinnedMetaRoot,
    offset: 0, limit: 1, sourcePacking: "complete-source" as const,
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const inspection = await inspectExtractionAuthority({ ...options,
    revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 }, inspection });
  const receiptPath = join(cacheRoot, "late-fixture-authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    const userPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
    const assertion = request.source_request.source_assertions[0]!;
    const rawJson = JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" }, content: {
      roots: [{ act: "assertion", expression: { kind: "content_ref", key: "completion" } }], entities: [],
      nodes: [{ kind: "statement", key: "completion",
        predicate: { kind: "explicit", reading: "complete", support: { assertion_id: assertion.assertion_id, text: "completed" } },
        arguments: [], qualifications: [] }], gaps: [] } });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: rawJson }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await runExtractionFill({ ...options, authorityReceiptPath: receiptPath });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const afterQualification = await prepareSourcePublicationAssociations({ ...config.source_population,
    openSemantics: parseExtractionOpenSemanticsGeneration(config.source_population.openSemantics ??
      EXTRACTION_OPEN_SEMANTICS_GENERATION) },
    config.cache_owners, join(root, "late-associations.json"));
  expect(afterQualification.publicationAssociations).toMatchObject([{
    source_id: window.window[0]!.source_id, source_version: window.window[0]!.source_version,
    generation_key: expect.any(String), request_digest: expect.any(String)
  }]);
  expect(afterQualification.publicationAssociations[0]).toMatchObject({
    generation_key: window.selected_missing_keys[0]
  });
  expect(afterQualification.artifacts).toMatchObject([{ status: "associated",
    sources: [window.window[0]!.source_id] }]);

  const after = await replayLazyQualifiedFirstExposure(root);
  const response = SoulInterpretationResponseSchema.parse(after.result.rows[0]?.response);
  if (response.operation !== "recall") throw new Error("native recall required");
  expect(after.path).toBe(first.path);
  expect(after.result.identity).toBe(first.result.identity);
  expect({ delivery_id: response.delivery_id, request_identity: response.request_identity,
    entries: response.index?.entries, order: response.order, proofs: response.proofs ?? [],
    results: response.results, slot_qualifiers: response.slot_qualifiers }).toEqual(initial);
  expect(readFileSync(join(root, "first-exposure.reserved.json"))).toEqual(reservation);
  expect(readFileSync(join(root, "first-exposure.json"))).toEqual(commitment);
  expect(readFileSync(join(root, "window.json"))).toEqual(frozenWindow);
  expect(readFileSync(join(root, "final.json"))).toEqual(frozenFinal);
  expect(readFileSync(inspectSemanticChainReplayTarget(final.final_chain_root, "retained")
    .rowPaths.get(window.query_key)!)).toEqual(nativeRow);
  expect(final.selected_new_associations).toBe(0);
});

it("freezes ten distinct native raw records and reopens a full sealed final library before one first exposure", async () => {
  const contents = Array.from({ length: 12 }, (_, index) =>
    index === 11 ? "I completed repeated." : index === 10 ? "I completed repeated." : `I completed item ${index}.`);
  const { config, published } = await preparedSourceFixture(contents);
  const root = join(cacheRoot, "lazy-stage");
  const window = await prepareLazyQualificationWindow(config, root);
  expect(window.provider_calls).toBe(0);
  expect(window.window).toHaveLength(10);
  expect(new Set(window.window.map(row => row.record_id)).size).toBe(10);
  expect(window.window.map(row => row.record_id)).toEqual(window.starting_access.source_candidates.slice(0, 10).map(row => row.record_id));
  expect(window.window.every(row => row.state === "cache_miss" && row.source_record.event_time === row.source_observed_at)).toBe(true);
  expect(window.starting_access.observed_source_count).toBe(12);
  expect(window.selected_missing_keys.length).toBeLessThanOrEqual(10);
  expect(JSON.parse(readFileSync(join(root, "selected-source-keys.json"), "utf8"))).toEqual(window.selected_missing_keys);
  expect(SourceSemanticAccessReceiptSchema.parse(window.starting_access).trace.kind).toBe("preparation_page");
  const final = await sealLazyQualificationFinal(root);
  expect(final).toMatchObject({ provider_calls: 0, selected_source_count: 10, selected_new_associations: 0 });
  expect(final.final_snapshot_path).not.toBe(published.snapshot_path);
  const finalReport = JSON.parse(readFileSync(final.publication_report_path, "utf8"));
  expect(finalReport.census_count).toBe(12);
  expect(finalReport.admitted_count).toBe(12);
  expect(finalReport.sources.filter((row: { publication: string }) => row.publication === "published")).toHaveLength(0);
  expect(final.final_access?.observed_source_count).toBe(12);
  const first = await replayLazyQualifiedFirstExposure(root);
  expect(first.result).toMatchObject({ provider_calls: 0, arm: "retained" });
  expect(first.result.rows[0]).toMatchObject({ status: "replayed", first_exposure: expect.any(Object) });
  expect(first.delivery.selected_delivered + first.delivery.selected_undelivered).toBe(10);
  expect(first.delivery.selected_delivered + first.delivery.outside_delivered).toBeLessThanOrEqual(5);
  expect(await replayLazyQualifiedFirstExposure(root)).toEqual(first);
  expect(readChainArtifact(join(root, "window.json"))).toEqual(window);
  const otherRoot = join(cacheRoot, "other-valid-chain");
  const otherPlan = await prepareSemanticChain({ ...config.chain, snapshot_path: final.final_snapshot_path,
    snapshot_sha256: final.final_snapshot_sha256 }, otherRoot);
  const finalPath = join(root, "final.json");
  const swapped = { ...readChainArtifact(finalPath) as object, final_chain_root: otherRoot,
    final_chain_identity: chainIdentity(otherPlan) };
  writeFileSync(finalPath, JSON.stringify({ identity: chainIdentity(swapped), payload: swapped }));
  await expect(sealLazyQualificationFinal(root)).rejects.toThrow(/final query plan|frozen source window/u);
  await expect(replayLazyQualifiedFirstExposure(root)).rejects.toThrow(/final query plan|frozen source window/u);
});

it("rejects a retained Batch source cap outside the native provider contract", async () => {
  const { config } = await preparedSourceFixture(["I completed alpha."]);
  const path = config.cache_owners[0]!.retainedPreparationPath;
  const retained = JSON.parse(readFileSync(path, "utf8"));
  retained.limits.maxOutputTokens = 65537;
  writeFileSync(path, JSON.stringify(retained));
  await expect(prepareLazyQualificationWindow(config, join(cacheRoot, "invalid-batch-cap")))
    .rejects.toThrow(/unsupported Gemini model\/request profile\/output settings/u);
});

it("binds a newly received duplicate-content result only to frozen occurrences while preserving raw outsiders", async () => {
  const fixture = await preparedSourceFixture(Array.from({ length: 12 }, () => "I completed alpha."));
  const config = { ...fixture.config, chain: { ...fixture.config.chain, correspondence_pair_cap: 10 } };
  const queryAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(config.chain.query_workset,
    config.chain.query_cache_root, 4096), inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  await executeSemanticProposalFill({ workset: config.chain.query_workset, cacheRoot: config.chain.query_cache_root,
    authority: queryAuthority, config: { providerUrl: "https://fixture-provider.invalid", model: MODEL,
      requestProfile: PROFILE, apiKey: "fixture" }, extractor: { extract: async () => {
      const rawJson = interpretedQueryRaw({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
          alternatives: [{ conditions: [{ kind: "statement", key: "complete", predicate: "complete",
            arguments: [{ role: "theme", target: { kind: "free", key: "theme", return: true }, excerpt: "What" }] }] }], gaps: [] });
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      return { rawJson, responseMetadata: { finishReason: "STOP" }, usage,
        responseBody: syntheticGeminiBody(rawJson, "STOP", usage) };
    } } });
  const root = join(cacheRoot, "duplicate-stage");
  const boundConfig = await fixture.bind(config.chain, "duplicate");
  const window = await prepareLazyQualificationWindow(boundConfig, root);
  expect(window.window).toHaveLength(10);
  expect(window.selected_missing_keys).toHaveLength(1);
  setExtractionCredentialFixture();
  const options = { variant: "longmemeval_s" as const, cacheRoot, dataDir, pinnedMetaRoot,
    offset: 0, limit: 1, sourcePacking: "complete-source" as const,
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const inspection = await inspectExtractionAuthority({ ...options,
    revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 }, inspection });
  const receiptPath = join(cacheRoot, "fixture-authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    const userPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
    const assertion = request.source_request.source_assertions[0]!;
    const rawJson = JSON.stringify(tableCompletedResponse(assertion.assertion_id, "alpha"));
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: rawJson }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await runExtractionFill({ ...options, authorityReceiptPath: receiptPath });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const final = await sealLazyQualificationFinal(root);
  const report = JSON.parse(readFileSync(final.publication_report_path, "utf8"));
  const selected = new Set(window.window.map(row => row.source_id));
  expect(report.census_count).toBe(12);
  expect(report.sources.filter((row: { source_id: string; publication: string }) => row.publication === "published")
    .map((row: { source_id: string }) => row.source_id).sort()).toEqual([...selected].sort());
  expect(report.sources.filter((row: { source_id: string; publication: string }) => !selected.has(row.source_id))
    .every((row: { publication: string }) => row.publication === "not_attempted")).toBe(true);
  expect(final).toMatchObject({ selected_new_associations: 10, warm_outside_associations: 0 });
  expect(final.final_access?.observed_source_count).toBe(12);
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(final.final_chain_root, "prepare.json")));
  expect(plan.queries[0]?.status).toBe("ready");
  const workset = plan.correspondence_workset!;
  const rawFirstFive = new Set(window.starting_access.source_candidates.slice(0, 5).map(row => row.source_id));
  const opportunity = materializeSemanticProposalLines(workset, 4096).findIndex(line =>
    !rawFirstFive.has((line.request as SourceSemanticCorrespondenceRequest)
      .source_interpretation_descriptors[0]!.interpretation.source.source_id));
  expect(opportunity).toBeGreaterThanOrEqual(0);
  const selectedItem = { ...workset, items: [workset.items[opportunity]!] };
  const request = materializeSemanticProposalLines(selectedItem, 4096)[0]!.request as SourceSemanticCorrespondenceRequest;
  const sourceInterpretation = request.source_interpretation_descriptors[0]!.interpretation;
  const predicate = request.catalog!.query_endpoints.find(row => row.kind === "predicate")!;
  const slot = request.catalog!.query_endpoints.find(row => row.kind === "slot")!;
  const frame = request.catalog!.source_endpoints.find(row => row.kind === "frame")!;
  const sourceSlot = request.catalog!.source_endpoints.find(row => row.kind === "slot")!;
  const support = sourceInterpretation.frames[0]!.predicate_support;
  const correspondenceAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(selectedItem,
    config.chain.correspondence_cache_root, 4096), inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  await executeSemanticProposalFill({ workset: selectedItem, cacheRoot: config.chain.correspondence_cache_root,
    authority: correspondenceAuthority, config: { providerUrl: "https://fixture-provider.invalid", model: MODEL,
      requestProfile: PROFILE, apiKey: "fixture" }, extractor: { extract: async () => {
      const rawJson = JSON.stringify({ contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, semantic_correspondence: {
          contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT, source_interpretation_handle: "source1",
          assessments: assessmentForTestPairs(request.catalog, request.original_query, [{ query: predicate.handle, source: frame.handle, query_excerpt: "completed",
            source_semantic_support: support.kind === "explicit" ? [{ kind: "lexical", mentions: support.mentions }] : [] },
          { query: slot.handle, source: sourceSlot.handle, query_excerpt: "What",
            source_semantic_support: sourceInterpretation.frames[0]!.slots[0]!.support }]) } });
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      return { rawJson, responseMetadata: { finishReason: "STOP" }, usage,
        responseBody: syntheticGeminiBody(rawJson, "STOP", usage) };
    } } });
  const replay = await replayLazyQualifiedFirstExposure(root);
  expect(replay.result.rows[0]).toMatchObject({ status: "replayed", first_exposure: expect.any(Object) });
  const native = SoulInterpretationResponseSchema.parse(replay.result.rows[0]?.response);
  expect(native.operation).toBe("recall");
  if (native.operation !== "recall") throw new Error("native recall required");
  expect(native.proofs?.length).toBeGreaterThan(0);
  expect(native.proofs?.some(row => row.source_interpretation_id === request.source_interpretation_descriptors[0]!.source_interpretation_id)).toBe(true);
  const chosenSource = request.source_interpretation_descriptors[0]!.interpretation.source.source_id;
  const chosenRecord = window.window.find(row => row.source_id === chosenSource);
  expect(chosenRecord).toBeDefined();
  expect(rawFirstFive.has(chosenSource)).toBe(false);
  expect(native.results?.some(row => row.target.kind === "source_evidence" && row.target.root_id === chosenRecord!.record_id)).toBe(true);
  expect(replay.delivery.selected_delivered + replay.delivery.selected_undelivered).toBe(10);
  expect(replay.delivery.selected_delivered + replay.delivery.outside_delivered).toBeLessThanOrEqual(5);
  expect(replay.delivery.selected_undelivered).toBeGreaterThan(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const nextQuery = parseSemanticProposalWorkset({ contract: semanticProposalWorksetContract(PROFILE),
    provider_url: "https://fixture-provider.invalid", kind: "query", model: MODEL, request_profile: PROFILE,
    items: [{ original_query: "Which item was completed?" }] });
  const nextRoot = join(cacheRoot, "next-query-stage");
  const next = await prepareLazyQualificationWindow(await fixture.bind({ ...config.chain,
    query_workset: nextQuery }, "next-query"), nextRoot);
  expect(next.window).toHaveLength(10);
  expect(next.window.every(row => row.state === "cache_hit_interpreted")).toBe(true);
  expect(next.selected_missing_keys).toEqual([]);
  const reused = await sealLazyQualificationFinal(nextRoot);
  expect(reused).toMatchObject({ selected_new_associations: 0, warm_outside_associations: 2 });
  const reusedReport = JSON.parse(readFileSync(reused.publication_report_path, "utf8"));
  expect(reusedReport.sources.filter((row: { publication: string }) => row.publication === "published")).toHaveLength(12);
  expect(reused.final_access?.observed_source_count).toBe(12);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retains a raw attempt without a cache shard as unknown and refuses a revised source census", async () => {
  const { config } = await preparedSourceFixture(["I completed alpha.", "I completed beta."]);
  const first = await prepareLazyQualificationWindow(config, join(cacheRoot, "before-attempt"));
  const chosen = first.window[0]!;
  expect(chosen.state).toBe("cache_miss");
  writeProviderRawAttempt({ root: cacheRoot, cacheKey: chosen.key!, attemptOrdinal: 1,
    kind: "source_semantic", model: MODEL, requestProfile: PROFILE,
    requestDigest: "a".repeat(64), decodedText: "{unfinished", finishReason: null });
  const failed = first.window[1]!;
  writeProviderRawAttempt({ root: cacheRoot, cacheKey: failed.key!, attemptOrdinal: 1,
    kind: "source_semantic", model: MODEL, requestProfile: PROFILE,
    requestDigest: "b".repeat(64), decodedText: "", finishReason: null,
    transportFailure: { kind: "network_error", phase: "request", httpStatus: null,
      fingerprint: "synthetic-failure", attempt: 1 } });
  const second = await prepareLazyQualificationWindow(config, join(cacheRoot, "after-attempt"));
  expect(second.window.find(row => row.source_id === chosen.source_id)).toMatchObject({
    state: "attempt_unknown", key: chosen.key });
  expect(second.window.find(row => row.source_id === failed.source_id)).toMatchObject({
    state: "attempt_failed", key: failed.key });
  expect(second.selected_missing_keys).not.toContain(chosen.key);
  expect(second.selected_missing_keys).not.toContain(failed.key);
  await writeDataset([question(["I completed revised alpha.", "I completed beta."])]);
  await expect(prepareLazyQualificationWindow(config, join(cacheRoot, "before-attempt"))).rejects.toThrow(/source census changed|dataset|complete source census/u);
  await expect(sealLazyQualificationFinal(join(cacheRoot, "before-attempt"))).rejects.toThrow(/source census changed|dataset|complete source census/u);
});

it("recovers a durable native replay after wrapper interruption but refuses a sent row without evidence", async () => {
  const { config } = await preparedSourceFixture(["I completed alpha.", "I completed beta."]);
  const root = join(cacheRoot, "recovered-exposure");
  await prepareLazyQualificationWindow(config, root);
  const final = await sealLazyQualificationFinal(root);
  const target = inspectSemanticChainReplayTarget(final.final_chain_root, "retained");
  writeChainArtifact(join(root, "first-exposure.reserved.json"), { final_identity: chainIdentity(final),
    replay_identity: target.identity, replay_path: target.output });
  const native = await replaySemanticChain(final.final_chain_root, "retained", target.identity);
  expect(readChainArtifact(join(root, "first-exposure.json"))).toBeUndefined();
  const recovered = await replayLazyQualifiedFirstExposure(root);
  expect(recovered.path).toBe(native.path);
  expect(recovered.result).toEqual(native.result);
  expect(await replayLazyQualifiedFirstExposure(root)).toEqual(recovered);

  const unresolvedRoot = join(cacheRoot, "unresolved-exposure");
  await prepareLazyQualificationWindow(config, unresolvedRoot);
  const unresolvedFinal = await sealLazyQualificationFinal(unresolvedRoot);
  const unresolvedTarget = inspectSemanticChainReplayTarget(unresolvedFinal.final_chain_root, "retained");
  writeChainArtifact(join(unresolvedRoot, "first-exposure.reserved.json"), {
    final_identity: chainIdentity(unresolvedFinal), replay_identity: unresolvedTarget.identity,
    replay_path: unresolvedTarget.output });
  const rowPath = [...unresolvedTarget.rowPaths.values()][0]!;
  writeChainArtifact(`${rowPath}.reserved`, { replay_identity: unresolvedTarget.identity,
    query_key: [...unresolvedTarget.rowPaths.keys()][0]! });
  await expect(replayLazyQualifiedFirstExposure(unresolvedRoot)).rejects.toThrow(/may have been sent/u);
  expect(readChainArtifact(unresolvedTarget.output)).toBeUndefined();
});

it("counts ledger reservations separately from raw receipts across the frozen window", async () => {
  const { config } = await preparedSourceFixture(["I completed alpha.", "I completed beta."]);
  const initial = await prepareLazyQualificationWindow(config, join(cacheRoot, "ledger-initial"));
  const [first, second] = initial.window;
  const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest: "c".repeat(64),
    cacheIdentity: { model: MODEL, requestProfile: PROFILE }, startingMissing: 2, maximumAttempts: 2 });
  expect(ledger.reserveAttemptOrdinal(first!.key!)).toBe(1);
  const root = join(cacheRoot, "ledger-stage");
  const window = await prepareLazyQualificationWindow(config, root);
  expect(window.window.find(row => row.key === first!.key)?.state).toBe("attempt_pending");
  writeProviderRawAttempt({ root: cacheRoot, cacheKey: first!.key!, attemptOrdinal: 1,
    kind: "source_semantic", model: MODEL, requestProfile: PROFILE, requestDigest: "d".repeat(64),
    decodedText: "unfinished", finishReason: null,
    usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } });
  expect(ledger.reserveAttemptOrdinal(second!.key!)).toBe(2);
  const final = await sealLazyQualificationFinal(root);
  expect(final.source_producer).toMatchObject({ new_authorized_attempts: 1,
    new_raw_receipts: 1, preexisting_attempt_raw_receipts: 1, reported_input_tokens: 0,
    reported_output_tokens: 0, unknown_usage_attempts: 1, unresolved_new_attempts: 1,
    attempt_history_complete: true });
});

it("does not count a copied continuation ledger as a new source call", async () => {
  const { config } = await preparedSourceFixture(["I completed alpha."]);
  const initial = await prepareLazyQualificationWindow(config, join(cacheRoot, "fork-initial"));
  const key = initial.window[0]!.key!;
  const lineage = "e".repeat(64), cacheIdentity = { model: MODEL, requestProfile: PROFILE };
  const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest: lineage,
    cacheIdentity, startingMissing: 1, maximumAttempts: 1 });
  const ordinal = ledger.reserveAttemptOrdinal(key);
  ledger.recordTransportOutcome(key, { retryCount: 0, rateLimitRetries: 0,
    successfulRequestCount: 0, unknownRequestCount: 1 }, ordinal);
  ledger.abandonPendingShard(key, ordinal);
  const root = join(cacheRoot, "fork-stage");
  const window = await prepareLazyQualificationWindow(config, root);
  expect(window.window[0]?.state).toBe("attempt_unknown");
  forkSettledExtractionAttemptLedger({ cacheRoot, predecessorLineageDigest: lineage,
    predecessorLedgerSha256: ledger.snapshot().ledgerSha256, successorLineageDigest: "f".repeat(64),
    cacheIdentity });
  const final = await sealLazyQualificationFinal(root);
  expect(final.source_producer).toMatchObject({ new_authorized_attempts: null,
    new_raw_receipts: 0, attempt_history_complete: false });
});

it("keeps a budget-limited long raw source in place without qualifying or replacing it", async () => {
  const { config, bind } = await preparedSourceFixture(["I completed alpha. ".repeat(5000), "I completed beta."]);
  const bounded = { ...config, chain: { ...config.chain, budget: { ...config.chain.budget,
    work_units: 50000, memory_bytes: 2_000_000, page_budget: 20000, finalization_reserve: 1000 } } };
  const window = await prepareLazyQualificationWindow(await bind(bounded.chain, "budgeted"), join(cacheRoot, "partial-stage"));
  expect(window.starting_access.observed_source_count).toBe(2);
  expect(window.window).toHaveLength(2);
  expect(window.window_open).toBe(true);
  const incomplete = window.window.find(row => row.state === "observation_incomplete");
  expect(incomplete).toBeDefined();
  expect(incomplete).toMatchObject({ key: null, cache_root: null });
  expect(window.selected_missing_keys.length).toBeLessThanOrEqual(1);
  const final = await sealLazyQualificationFinal(join(cacheRoot, "partial-stage"));
  expect(final).toMatchObject({ selected_new_associations: 0, warm_outside_associations: 0 });
  const report = JSON.parse(readFileSync(final.publication_report_path, "utf8"));
  expect(report).toMatchObject({ census_count: 2, admitted_count: 2 });
  const first = await replayLazyQualifiedFirstExposure(join(cacheRoot, "partial-stage"));
  expect(first.result.rows).toHaveLength(1);
  expect(first.delivery.selected_delivered + first.delivery.selected_undelivered).toBe(2);
});

it("retains unsupported dispositions inside and outside the shortlist without interpretation attempts", async () => {
  const { config } = await preparedSourceFixture(Array.from({ length: 12 }, (_, index) =>
    `I completed item ${index}. ` + Array.from({ length: 128 }, (_, part) => `Part ${part} occurred.`).join(" ")));
  const root = join(cacheRoot, "unsupported-stage");
  const window = await prepareLazyQualificationWindow(config, root);
  expect(window.window).toHaveLength(10);
  expect(window.window.every(row => row.state === "unsupported_source")).toBe(true);
  expect(window.selected_missing_keys).toEqual([]);
  const final = await sealLazyQualificationFinal(root);
  expect(final).toMatchObject({ selected_new_associations: 0, warm_outside_associations: 0,
    source_producer: { new_authorized_attempts: 0, new_raw_receipts: 0 } });
  const report = JSON.parse(readFileSync(final.publication_report_path, "utf8"));
  expect(report).toMatchObject({ census_count: 12, admitted_count: 12,
    host_preparation_counts: { unsupported_source: 12 }, published_count: 0 });
  expect(report.sources.every((row: { provider_attempts: number }) => row.provider_attempts === 0)).toBe(true);
  const first = await replayLazyQualifiedFirstExposure(root);
  expect(first.result.rows).toHaveLength(1);
  expect(first.delivery.selected_delivered + first.delivery.selected_undelivered).toBe(10);
});

async function fillAuthoredCompletionQuery(workset: Parameters<typeof prepareSemanticProposal>[0], queryCacheRoot: string) {
  const queryAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(
    workset, queryCacheRoot, 4096),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  await executeSemanticProposalFill({ workset,
    cacheRoot: queryCacheRoot, authority: queryAuthority,
    config: { providerUrl: "https://fixture-provider.invalid", model: MODEL,
      requestProfile: PROFILE, apiKey: "fixture" }, extractor: { extract: async () => {
      const rawJson = interpretedQueryRaw({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
          alternatives: [{ conditions: [{ kind: "statement", key: "complete", predicate: "complete",
            arguments: [{ role: "theme", target: { kind: "free", key: "theme", return: true },
              excerpt: "What" }] }] }], gaps: [] });
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      return { rawJson, responseMetadata: { finishReason: "STOP" }, usage,
        responseBody: syntheticGeminiBody(rawJson, "STOP", usage) };
    } } });
}

function shortSourceBatchResponse(line: { key: string; request: { contents: { parts: { text: string }[] }[] } }) {
  const request = parseSourceSemanticRequest(JSON.parse(line.request.contents[0]!.parts[0]!.text));
  const assertion = request.source_request.source_assertions[0]!;
  const theme = /^User: I completed (beta|item \d+)\.$/u.exec(assertion.text)?.[1];
  if (theme === undefined) throw new Error("sample requested a non-short or unsupported source");
  const rawJson = JSON.stringify(tableCompletedResponse(assertion.assertion_id, theme));
  return JSON.stringify({ key: line.key, response: { candidates: [{ finishReason: "STOP",
    content: { parts: [{ text: rawJson }] } }], usageMetadata: {
      promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } } });
}

function installStrictShortSourceBatchMock() {
  let upload = "", displayName = "", creates = 0;
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const requestUrl = new URL(String(url));
    const path = requestUrl.pathname;
    const method = init?.method ?? "GET";
    if (requestUrl.origin !== "https://fixture-provider.invalid") {
      throw new Error(`unexpected offline request ${method} ${requestUrl.origin}${path}`);
    }
    if (method === "POST" && path === "/upload/v1beta/files") return new Response(null,
      { headers: { "x-goog-upload-url": "https://fixture-provider.invalid/upload-session" } });
    if (method === "POST" && path === "/upload-session") {
      upload = String(init?.body);
      return Response.json({ file: { name: "files/input" } });
    }
    if (method === "POST" && path === `/v1beta/models/${MODEL}:batchGenerateContent`) {
      creates++;
      displayName = JSON.parse(String(init?.body)).batch.displayName;
      return Response.json({ name: "batches/job" });
    }
    if (method === "GET" && path === "/v1beta/batches/job") return Response.json({ name: "batches/job", metadata: {
      displayName, model: `models/${MODEL}`, state: "BATCH_STATE_SUCCEEDED",
      inputConfig: { fileName: "files/input" }, output: { responsesFile: "files/output" } } });
    if (method === "GET" && path === "/download/v1beta/files/output:download") return new Response(upload.trim().split("\n")
      .map(line => shortSourceBatchResponse(JSON.parse(line))).join("\n"));
    throw new Error(`unexpected offline request ${method} ${requestUrl.origin}${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, createCount: () => creates };
}

it("rejects Batch requests with a foreign origin, wrong method or wrong model route", async () => {
  const { fetchMock, createCount } = installStrictShortSourceBatchMock();
  const createPath = `/v1beta/models/${MODEL}:batchGenerateContent`;
  await expect(fetchMock(new URL(`https://unexpected-provider.invalid${createPath}`),
    { method: "POST" })).rejects.toThrow(/unexpected offline request/u);
  await expect(fetchMock(new URL(`https://fixture-provider.invalid${createPath}`),
    { method: "GET" })).rejects.toThrow(/unexpected offline request/u);
  await expect(fetchMock(new URL("https://fixture-provider.invalid/v1beta/models/gemini-wrong:batchGenerateContent"),
    { method: "POST" })).rejects.toThrow(/unexpected offline request/u);
  expect(createCount()).toBe(0);
});

async function fillAuthoredCompletionCorrespondence(
  workset: Parameters<typeof materializeSemanticProposalLines>[0], opportunity: number,
  correspondenceCacheRoot: string
) {
  const selected = { ...workset, items: [workset.items[opportunity]!] };
  const request = materializeSemanticProposalLines(selected, 4096)[0]!.request as SourceSemanticCorrespondenceRequest;
  const interpretation = request.source_interpretation_descriptors[0]!.interpretation;
  const predicate = request.catalog!.query_endpoints.find(row => row.kind === "predicate")!;
  const slot = request.catalog!.query_endpoints.find(row => row.kind === "slot")!;
  const frame = request.catalog!.source_endpoints.find(row => row.kind === "frame")!;
  const sourceSlot = request.catalog!.source_endpoints.find(row => row.kind === "slot")!;
  const support = interpretation.frames[0]!.predicate_support;
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(selected,
    correspondenceCacheRoot, 4096), inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  return executeSemanticProposalFill({ workset: selected, cacheRoot: correspondenceCacheRoot,
    authority, config: { providerUrl: "https://fixture-provider.invalid", model: MODEL,
      requestProfile: PROFILE, apiKey: "fixture" }, extractor: { extract: async () => {
      const rawJson = JSON.stringify({ contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, semantic_correspondence: {
          contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT,
          source_interpretation_handle: "source1", assessments: assessmentForTestPairs(request.catalog, request.original_query, [
            { query: predicate.handle, source: frame.handle, query_excerpt: "completed",
              source_semantic_support: support.kind === "explicit" ?
                [{ kind: "lexical", mentions: support.mentions }] : [] },
            { query: slot.handle, source: sourceSlot.handle, query_excerpt: "What",
              source_semantic_support: interpretation.frames[0]!.slots[0]!.support }
          ]) } });
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      return { rawJson, responseMetadata: { finishReason: "STOP" }, usage,
        responseBody: syntheticGeminiBody(rawJson, "STOP", usage) };
    } } });
}

async function fillFrozenShortSources(selectedKeys: readonly string[]) {
  setExtractionCredentialFixture();
  // Keep native source versions fixed while the Batch sample uses its admitted first-100 inventory.
  const sampleDataDir = join(cacheRoot, "sample-data"), sampleMetaRoot = join(cacheRoot, "sample-pinned");
  mkdirSync(sampleDataDir);
  mkdirSync(sampleMetaRoot);
  const originalQuestions = JSON.parse(readFileSync(join(dataDir, "longmemeval_s.json"), "utf8"));
  expect(originalQuestions).toHaveLength(1);
  await writeExtractionFillDataset(sampleDataDir, sampleMetaRoot, [
    ...originalQuestions,
    ...Array.from({ length: 99 }, (_, index) => ({ ...question([]), question_id: `empty-${index}` }))
  ], "longmemeval_s");
  const sourceCacheRoot = join(cacheRoot, "sample-source-cache");
  const fillOptions = { variant: "longmemeval_s" as const, cacheRoot: sourceCacheRoot,
    dataDir: sampleDataDir, pinnedMetaRoot: sampleMetaRoot,
    offset: 0, limit: 100, sourcePacking: "complete-source" as const,
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const inspection = await inspectExtractionAuthority({ ...fillOptions,
    revision: readCurrentExtractionAuthorityRevision(), action: "sample" });
  const sampleScope = createExtractionSampleScope(selectedKeys, inspection);
  rmdirSync(sourceCacheRoot);
  const selection = createFreshRetiredSourceRebuildTargetSelection({ cacheRoot: sourceCacheRoot,
    operator: "fixture-operator", observation: inspection.observation });
  const targetSelectionReceiptPath = join(cacheRoot, "composition-target-selection.json");
  writeExtractionTargetSelectionReceipt(targetSelectionReceiptPath, selection);
  const receipt = createExtractionAuthorityReceipt({ action: "sample", sampleScope,
    observation: inspection.observation, inspection, targetSelectionDigest: selection.receipt_digest,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 100000 } });
  const authorityReceiptPath = join(cacheRoot, "composition-sample-authority.json");
  writeExtractionAuthorityReceipt(authorityReceiptPath, receipt);
  const limits: GeminiBatchLimits = { maxJobs: 1, maxRequestsPerJob: 10, maxFileBytes: 1000000,
    maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000, maxOutputTokens: 4096,
    maxUsd: receipt.price.estimated_upper_usd, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 };
  const { fetchMock, createCount } = installStrictShortSourceBatchMock();
  const fill = (operation: "prepare" | "submit" | "resume" | "import") =>
    runExtractionFill({ ...fillOptions, authorityReceiptPath, targetSelectionReceiptPath,
      batch: { operation, limits, window: "sample" }, log: () => undefined });
  await fill("prepare");
  const plan = JSON.parse(readFileSync(join(sourceCacheRoot, "gemini-batch-plan-sample.json"), "utf8")) as GeminiBatchPlan;
  expect(plan.lines).toHaveLength(10);
  expect([...plan.lines.map(line => line.key)].sort()).toEqual([...selectedKeys].sort());
  await fill("submit");
  const imported = await fill("resume");
  await fill("import");
  expect(createCount()).toBe(1);
  expect(imported.authorityTelemetry).toMatchObject({ attempts: 10, successfulShards: 10 });
  return { plan, imported, fetchMock, createCount };
}

it("records whether three cold authored composition windows share the same eligible first ten", async () => {
  const contents = ["I completed alpha. ".repeat(5000), "I completed beta.",
    ...Array.from({ length: 10 }, (_, index) => `I completed item ${index + 2}.`)];
  const fixture = await preparedSourceFixture(contents, 100000, join(cacheRoot, "sample-source-cache"));
  await fillAuthoredCompletionQuery(fixture.config.chain.query_workset, fixture.config.chain.query_cache_root);
  const normalChain = fixture.config.chain;
  const smallChain = { ...normalChain, output_byte_limit: 21600, budget: { ...normalChain.budget,
    work_units: 50000, memory_bytes: 2_000_000, page_budget: 20000, finalization_reserve: 1000 } };
  const stages = [
    await fixture.bind(normalChain, "composition-cold"),
    await fixture.bind(normalChain, "composition-qualified-normal"),
    await fixture.bind(smallChain, "composition-qualified-small")
  ];
  const roots = ["composition-cold", "composition-qualified-normal", "composition-qualified-small"]
    .map(name => join(cacheRoot, name));
  const windows = [];
  for (let index = 0; index < roots.length; index++) {
    windows.push(await prepareLazyQualificationWindow(stages[index]!, roots[index]!));
  }
  const tuples = windows.map(window => window.window.map(row =>
    [row.source_id, row.source_version, row.record_id]));
  const eligible = windows.map(window => window.window.filter(row => row.state === "cache_miss" && row.key !== null)
    .map(row => ({ source_id: row.source_id, key: row.key })));
  const matched = tuples.every(rows => rows.length === 10 && JSON.stringify(rows) === JSON.stringify(tuples[0]))
    && eligible.every(rows => rows.length === 10 && JSON.stringify(rows) === JSON.stringify(eligible[0]));
  const returnRoot = process.env.COMPOSITION_CONTROL_RETURN_ROOT;
  if (returnRoot !== undefined) {
    mkdirSync(returnRoot);
    writeFileSync(join(returnRoot, "window-trace.json"), JSON.stringify({
      candidate: windows[0]!.config.chain.implementation_revision, matched, tuples, eligible,
      windows: windows.map(window => ({ query_state_identity: window.query_state_identity,
        starting_snapshot_sha256: window.starting_snapshot_sha256,
        starting_publication_identity: window.starting_publication_identity,
        source_inventory_identity: window.source_inventory_identity,
        dataset_sha256: window.dataset_sha256, window_open: window.window_open,
        starting_access: window.starting_access, starting_discovery_work: window.starting_discovery_work,
        starting_host_elapsed_ms: window.starting_host_elapsed_ms,
        selected_missing_keys: window.selected_missing_keys,
        window: window.window.map(row => ({ rank: row.rank, source_id: row.source_id,
          source_version: row.source_version, record_id: row.record_id, state: row.state,
          key: row.key })) })) }, null, 2));
    cpSync(cacheRoot, join(returnRoot, "native-cache"), { recursive: true });
  }
  expect(windows.map(window => window.query_state_identity))
    .toEqual(Array(3).fill(windows[0]!.query_state_identity));
  expect(windows.map(window => window.starting_snapshot_sha256))
    .toEqual(Array(3).fill(windows[0]!.starting_snapshot_sha256));
  if (!matched) return; // No H/C is prepared when the native window lacks a common eligible first ten.
  const coldFinal = await sealLazyQualificationFinal(roots[0]!);
  const coldExposure = await replayLazyQualifiedFirstExposure(roots[0]!);
  expect(coldExposure.result.rows[0]?.status).toBe("replayed");
  if (returnRoot !== undefined) {
    writeFileSync(join(returnRoot, "cold-final.json"), JSON.stringify({ coldFinal,
      delivery: coldExposure.delivery, result: coldExposure.result }, null, 2));
    cpSync(cacheRoot, join(returnRoot, "native-cache"), { recursive: true, force: true });
  }
  const { plan, imported, fetchMock, createCount } = await fillFrozenShortSources(windows[1]!.selected_missing_keys);
  const normalFinal = await sealLazyQualificationFinal(roots[1]!);
  const smallFinal = await sealLazyQualificationFinal(roots[2]!);
  if (returnRoot !== undefined) {
    writeFileSync(join(returnRoot, "qualified-finals.json"), JSON.stringify({ plan, batchState: imported.batchState,
      authorityTelemetry: imported.authorityTelemetry, normalFinal, smallFinal,
      mock: { createCount: createCount(), fetchCount: fetchMock.mock.calls.length } }, null, 2));
    cpSync(cacheRoot, join(returnRoot, "native-cache"), { recursive: true, force: true });
  }
  const finalPlans = [normalFinal, smallFinal].map(final => SemanticChainPlanSchema.parse(
    readChainArtifact(join(final.final_chain_root, "prepare.json"))));
  const worksets = finalPlans.map(plan => plan.correspondence_workset);
  const lines = worksets.map(workset => workset == null ? [] : materializeSemanticProposalLines(workset, 4096));
  const normalOpportunity = lines[0]!.findIndex(line => {
    const request = line.request as SourceSemanticCorrespondenceRequest;
    return eligible[1]!.some(row => row.source_id ===
      request.source_interpretation_descriptors[0]?.interpretation.source.source_id);
  });
  const targetSource = normalOpportunity < 0 ? undefined : (lines[0]![normalOpportunity]!
    .request as SourceSemanticCorrespondenceRequest).source_interpretation_descriptors[0]!.interpretation.source.source_id;
  const smallOpportunity = lines[1]!.findIndex(line => (line.request as SourceSemanticCorrespondenceRequest)
    .source_interpretation_descriptors[0]?.interpretation.source.source_id === targetSource);
  if (returnRoot !== undefined) writeFileSync(join(returnRoot, "correspondence-opportunities.json"), JSON.stringify({
    finalPlanStatus: finalPlans.map(plan => plan.queries[0]?.status), targetSource,
    normalOpportunity, smallOpportunity, advertisedCounts: lines.map(rows => rows.length) }, null, 2));
  if (targetSource === undefined || smallOpportunity < 0 || worksets[0] == null || worksets[1] == null) return;
  for (const [stage, opportunity] of [normalOpportunity, smallOpportunity].entries()) {
    await fillAuthoredCompletionCorrespondence(worksets[stage]!, opportunity,
      normalChain.correspondence_cache_root);
  }
  const qualifiedExposure = [];
  for (const root of roots.slice(1)) qualifiedExposure.push(await replayLazyQualifiedFirstExposure(root));
  expect(qualifiedExposure.every(exposure => exposure.result.rows[0]?.status === "replayed")).toBe(true);
  if (returnRoot !== undefined) {
    writeFileSync(join(returnRoot, "qualified-exposures.json"), JSON.stringify(qualifiedExposure, null, 2));
    cpSync(cacheRoot, join(returnRoot, "native-cache"), { recursive: true, force: true });
  }
}, 120000);

it("delivers the fixed completed item through the normal native qualification lifecycle", async () => {
  const contents = ["I completed alpha. ".repeat(5000), "I completed beta.",
    ...Array.from({ length: 10 }, (_, index) => `I completed item ${index + 2}.`)];
  const expectedWindow = [5, 11, 3, 8, 1, 10, 9, 2, 6, 7];
  const expectedSourceKeys = [
    ["fixture:bounded-s5-r0", "e0e7e5b00e6ab7f2451b8d2698434812a1c49ce18471b79dfaa9bf2b5daf6b7e"],
    ["fixture:bounded-s11-r0", "1e2a56109c5a0ba84185dc3c80c7c7d81ba86dc0b835032b203bad09b4af154d"],
    ["fixture:bounded-s3-r0", "6fb835f9d2f3412b389c0d3b43d2b608c3dc574c8b6b946e5042ebc00fcf5949"],
    ["fixture:bounded-s8-r0", "211b3768caa73df9d71cad67bb37167ddc089e4513924f511b39b115ca77b63b"],
    ["fixture:bounded-s1-r0", "8edc47689992851f7112a6e7985b93bd3ae8a7a38fea9a13feadeb7a65369aa0"],
    ["fixture:bounded-s10-r0", "519b8ac588569b6aad9e243d693511f99119eec2491c0009622570e55e1c860f"],
    ["fixture:bounded-s9-r0", "bdf9e862d92b79bbe0863f306324cf1ac74ae099cc539d420ce23f58cc3f2a86"],
    ["fixture:bounded-s2-r0", "97003876395602856c9abafc0e097bec920dc4f9eff1a3e0f668ca105da47d52"],
    ["fixture:bounded-s6-r0", "4b8fff15db51563466b734248427dcd59b503f1540c3e7ec9e607ace9d5582fa"],
    ["fixture:bounded-s7-r0", "ba2fca4bbe6e9cbf9831c3000ba288d5aa70940cc687e8f2650e8b3efae43722"]
  ] as const;
  const expectedRecords = ["06a672c9f0466751e19d3c33f56bbee649e49b7b7da3e306d58e5f7a98a43da5",
    "3c1de53a4a3dc4c90a2464191796b78ffe21a1f614f6042d8cc535d3cbbeeca1",
    "48545d4cf4d1afb623e34beb815545a7b416c393dc6d31c4d18ca617e65ae90c",
    "4e0f9b0e4269c04741a7847fb5a2361778b98a519f59227a5f1597ed5cb9635f",
    "7769a015fccf0024ec25838cb3a8157943fbbc54bbca4df6832eae19978d5fe3",
    "831e98ffc460a07e8e511956b6a7adf9dde4e0e60527406b839665b675e5898c",
    "9d5d61d11627d84c62cd2d11cb952bea79352b55a2d7d263983105023604c4bb",
    "a89904be290bb1da70bd7b72953126fc7bce40821fc0f5b9c47c73d1cb9e2f83",
    "c37d8fcb63aa303cf593a6d64538edd77baa129eb97bb76c8876525e9aecc036",
    "e4c84c830b3eab4dd8a1b6c4df779e8f689334d744021f193bcabc82d9a9eca7"]
    .map(digest => `sha256:${digest}`);
  const returnRoot = process.env.NATIVE_DELIVERY_CONTROL_RETURN_ROOT;
  if (returnRoot !== undefined) mkdirSync(returnRoot, { recursive: true });
  try {
    const fixture = await preparedSourceFixture(contents, 100000, join(cacheRoot, "sample-source-cache"));
    await fillAuthoredCompletionQuery(fixture.config.chain.query_workset,
      fixture.config.chain.query_cache_root);
    const config = await fixture.bind(fixture.config.chain, "normal-lifecycle");
    const root = join(cacheRoot, "normal-lifecycle-stage");
    const window = await prepareLazyQualificationWindow(config, root);
    if (returnRoot !== undefined) writeFileSync(join(returnRoot, "window.json"), JSON.stringify(window, null, 2));
    expect(window.config.chain.query_workset.items).toEqual([{ original_query: "What was completed?" }]);
    // Composition guidance in the system prompt is part of the request identity once the query schema exceeds the structured budget.
    expect(window.query_key).toBe("79b9faccf403aa12ec582ad1f2e904bc6e82a0a26089ac9bb5cc342840829e48");
    expect(window.window.map(row => row.source_id)).toEqual(expectedWindow.map(index => `fixture:bounded-s${index}-r0`));
    expect(window.window.map(row => row.record_id)).toEqual(expectedRecords);
    expect(window.window.map(row => row.source_version)).toEqual(Array(10)
      .fill("55e8c8cc90876bdfbe5295ba2bd9be3c4fb89f8fe4cfa181e5394c9c970d7814"));
    expect(window.window.map(row => row.state)).toEqual(Array(10).fill("cache_miss"));
    expect(window.selected_missing_keys).toHaveLength(10);
    expect(window.window.map(row => [row.source_id, row.key])).toEqual(expectedSourceKeys);
    expect(new Set(window.selected_missing_keys)).toEqual(new Set(expectedSourceKeys.map(([, key]) => key)));
    expect(window.starting_access.source_candidates.map(row => row.source_id))
      .toEqual([5, 11, 3, 8, 1, 10, 9, 2, 6, 7, 4, 0].map(index => `fixture:bounded-s${index}-r0`));
    const { plan: batchPlan, imported, fetchMock, createCount } = await fillFrozenShortSources(window.selected_missing_keys);
    const final = await sealLazyQualificationFinal(root);
    const report = JSON.parse(readFileSync(final.publication_report_path, "utf8"));
    if (returnRoot !== undefined) writeFileSync(join(returnRoot, "qualified-final.json"),
      JSON.stringify({ final, report, batchPlan, authorityTelemetry: imported.authorityTelemetry }, null, 2));
    expect(final.final_snapshot_sha256).not.toBe(window.starting_snapshot_sha256);
    expect(report).toMatchObject({ census_count: 12, admitted_count: 12, published_count: 10, rejected_count: 0 });
    expect(report.sources.map((row: { source_id: string; source_version: string; record_id: string }) =>
      [row.source_id, row.source_version, row.record_id])).toEqual(fixture.published.sources.map(row =>
      [row.source_id, row.source_version, row.record_id]));
    expect(report.sources.filter((row: { publication: string }) => row.publication === "published")
      .map((row: { source_id: string }) => row.source_id).sort())
      .toEqual(expectedWindow.map(index => `fixture:bounded-s${index}-r0`).sort());
    expect(report.sources.filter((row: { publication: string }) => row.publication !== "published")
      .map((row: { source_id: string }) => row.source_id).sort())
      .toEqual(["fixture:bounded-s0-r0", "fixture:bounded-s4-r0"]);
    expect(report.sources[0]).toMatchObject({ host_preparation: { status: "unsupported_source",
      reason: { dimension: "assertions", actual: 5000, limit: 128 } }, source_interpretation: "absent" });
    expect(report.sources[4]).toMatchObject({ host_preparation: { status: "ready" },
      source_interpretation: "absent", publication: "not_attempted" });
    expect(final).toMatchObject({ selected_new_associations: 10, warm_outside_associations: 0,
      provider_calls: 0, source_producer: { new_authorized_attempts: 10, new_raw_receipts: 0,
        unknown_usage_attempts: 10, unresolved_new_attempts: 10 } });
    const chainPlan = SemanticChainPlanSchema.parse(readChainArtifact(join(final.final_chain_root, "prepare.json")));
    const query = chainPlan.queries[0]!;
    const workset = chainPlan.correspondence_workset!;
    const lines = materializeSemanticProposalLines(workset, 4096);
    if (returnRoot !== undefined) writeFileSync(join(returnRoot, "opportunity.json"),
      JSON.stringify({ query, lines: lines.map(line => ({ key: line.key, request: line.request })) }, null, 2));
    expect(query.status).toBe("ready");
    if (query.status !== "ready") throw new Error("fixed source requires a ready native opportunity");
    expect(query.descriptors.map(row => row.source_id)).toEqual(["fixture:bounded-s2-r0"]);
    expect(query.correspondence_opportunities).toEqual([{
      source_interpretation_id: query.descriptors[0]!.interpretation_id, decision: "selected" }]);
    expect(query).toMatchObject({ discovery_open: true, discovery_truncated: true,
      unvisited_source_interpretation_count: null });
    expect(lines).toHaveLength(1);
    const request = lines[0]!.request as SourceSemanticCorrespondenceRequest;
    expect(request.source_interpretation_descriptors[0]?.interpretation.source.source_id)
      .toBe("fixture:bounded-s2-r0");
    const correspondence = await fillAuthoredCompletionCorrespondence(workset, 0,
      fixture.config.chain.correspondence_cache_root);
    if (returnRoot !== undefined) writeFileSync(join(returnRoot, "correspondence.json"),
      JSON.stringify(correspondence, null, 2));
    expect(correspondence).toMatchObject({ requested: 1, newly_admitted: 1,
      interpreted: 1, rejected: 0, incomplete: 0, unknown: 0 });
    const exposure = await replayLazyQualifiedFirstExposure(root);
    if (returnRoot !== undefined) writeFileSync(join(returnRoot, "exposure.json"), JSON.stringify(exposure, null, 2));
    expect(exposure.result.rows[0]?.status).toBe("replayed");
    const row = exposure.result.rows[0]!;
    const native = SoulInterpretationResponseSchema.parse(row.response);
    if (native.operation !== "recall" || native.index === undefined) throw new Error("native indexed recall required");
    const roots = native.index.entries.map(entry => entry.target.kind === "source_evidence" ? entry.target.root_id : null);
    expect(roots).toEqual([2, 5, 11, 3, 8].map(index =>
      report.sources.find((source: { source_id: string }) => source.source_id === `fixture:bounded-s${index}-r0`)?.record_id));
    expect(roots).not.toContain(report.sources[4]?.record_id);
    const target = report.sources[2]!.record_id;
    const slot = native.slot_qualifiers?.[0];
    const proof = native.proofs?.find(value => value.source_interpretation_id === query.descriptors[0]!.interpretation_id);
    expect(slot).toMatchObject({ index: 0, evidence_kind: "semantic_proof", selection_basis: "direct_answer",
      source_interpretation_id: query.descriptors[0]!.interpretation_id, payload_support: "available" });
    expect(proof).toMatchObject({ source_target: { root_id: target }, semantic_status: "unreviewed",
      conclusion_scope: "conditional_on_interpretation", world_claim: "unknown" });
    expect(proof?.binding_results?.some(binding => binding.query_complete && Object.keys(binding.returned).length > 0))
      .toBe(true);
    const answer = proof?.binding_results?.find(binding => binding.kind === "answer" && binding.query_complete);
    const themeMention = proof?.interpretation.mentions.find(mention => mention.text === "item 2");
    const themeReferent = proof?.interpretation.referents.find(referent =>
      themeMention !== undefined && referent.mentions.includes(themeMention.id));
    expect(answer).toBeDefined();
    expect(themeMention).toBeDefined();
    expect(themeReferent).toBeDefined();
    expect(answer?.returned.theme?.node_id).toBe(themeReferent?.id);
    expect(answer?.returned.theme?.packet_id).toBe(proof?.source_interpretation_id);
    expect(slot?.witnesses?.[0]?.binding_id).toBe(answer?.binding_id);
    expect(slot?.conditional_computation_id).toBe(proof?.conditional_computation_id);
    expect(slot?.semantic_correspondence_id).toBe(proof?.semantic_correspondence_id);
    expect(proof?.consumed_leaves.some(leaf => leaf.leaf_kind.startsWith("source_interpretation_"))).toBe(true);
    expect(proof?.consumed_leaves.some(leaf => leaf.leaf_kind.startsWith("semantic_correspondence_"))).toBe(true);
    const result = native.results?.[0];
    expect(result).toMatchObject({ object_kind: "semantic_proof", target: { root_id: target } });
    expect(result?.content_preview).toBe("User: I completed item 2.");
    expect(result?.target).toEqual(native.index.entries[0]!.target);
    expect(result?.output_binding).toBe(answer?.binding_id);
    expect(native.index.entries[0]?.interpretation_node?.packet_id).toBe(proof?.source_interpretation_id);
    expect(native.request_identity).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const span = native.index.entries[0]!.target.kind === "source_evidence" ? native.index.entries[0]!.target.span : null;
    expect(span).toMatchObject({ content_start: 0, content_end: 25, content_complete: true });
    expect(Buffer.byteLength(result!.content_preview!.slice(span!.content_start, span!.content_end))).toBe(25);
    const validated = measureSourceSemanticLibraryResponse({ recallResult: native,
      firstExposurePage: row.first_exposure!, requestBudget: fixture.config.chain.budget,
      sourceRecords: report.sources.map((source: { source_record: unknown }) => source.source_record), goldSourceUnits: [] });
    expect(validated.measurement?.status).toBe("validated");
    expect(validated.validatedProofRanks).toContain(1);
    expect(row.first_exposure).toMatchObject({ delivery_id: native.delivery_id, page_purpose: "membership",
      initial: { delivery_id: native.delivery_id } });
    expect(row.first_exposure?.initial?.slots[0]).toMatchObject({ rank: 1, object_kind: "semantic_proof",
      target: { root_id: target } });
    expect(row.first_exposure?.initial?.identity).toMatchObject({ query_id: native.index.query_id,
      snapshot_id: native.index.snapshot_id, interpretation_id: native.index.interpretation_id,
      as_of: native.index.as_of });
    expect(exposure.delivery).toMatchObject({ selected_delivered: 5, selected_undelivered: 5, outside_delivered: 0 });
    expect(native.discovery?.access?.unvisited_sources).toBe(true);
    expect(native.discovery?.access?.unvisited_interpretations).toBe(true);
    expect(native.index.completeness?.observed_coverage).toBe("open");
    expect(exposure.result.provider_calls).toBe(0);
    expect(createCount()).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(5);
  } finally {
    if (returnRoot !== undefined && cacheRoot !== undefined) cpSync(cacheRoot, join(returnRoot, "native-cache"),
      { recursive: true, force: true });
  }
}, 120000);
