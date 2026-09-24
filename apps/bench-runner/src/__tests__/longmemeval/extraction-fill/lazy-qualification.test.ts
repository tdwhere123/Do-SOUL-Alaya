import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { registerExtractionFillHooks } from "./fixture.js";
import { preflightExtractionBatch } from "../../../runs/extraction/fill/batch-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, parseExtractionOpenSemanticsGeneration } from "../../../runs/extraction/request-artifact.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { prepareSourcePublicationAssociations } from "../../../runs/snapshot/source-records/prepare-associations.js";
import { parseSemanticProposalWorkset, semanticProposalWorksetContract } from "../../../runs/semantic-proposal/workset.js";
import { materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { prepareSemanticProposal, executeSemanticProposalFill } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { prepareLazyQualificationWindow, replayLazyQualifiedFirstExposure,
  sealLazyQualificationFinal } from "../../../runs/semantic-chain/lazy-qualification.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact,
  writeChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { admitNativeLazyConfig } from "../../../runs/semantic-chain/bind-lazy.js";
import { inspectSemanticChainReplayTarget, replaySemanticChain } from "../../../runs/semantic-chain/replay.js";
import { SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SoulInterpretationResponseSchema, SourceSemanticAccessReceiptSchema } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT,
  type SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { interpretedQueryRaw } from "../query-producer-fixture.js";
import { setExtractionCredentialFixture } from "./fixture.js";
import { inspectExtractionAuthority } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
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

async function preparedSourceFixture(contents: readonly string[], outputByteLimit = 100000) {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  await writeDataset([question(contents)]);
  const preflight = await preflightExtractionBatch({ variant: "longmemeval_s", cacheRoot, dataDir, pinnedMetaRoot,
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
      sourcePreflightPath: preflightPath, sourceCacheRoot: cacheRoot,
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
  const { config } = await preparedSourceFixture(contents, 21600);
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
    const rawJson = JSON.stringify({ contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" }, content: {
      roots: [{ act: "assertion", expression: { kind: "statement",
        predicate: { kind: "explicit", reading: "complete", support: { assertion_id: assertion.assertion_id, text: "completed" } },
        arguments: [] } }] } });
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
      requestProfile: PROFILE, apiKey: "fixture" }, extractor: { extract: async () => ({
      rawJson: interpretedQueryRaw({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
          alternatives: [{ conditions: [{ kind: "statement", key: "complete", predicate: "complete",
            arguments: [{ role: "theme", target: { kind: "free", key: "theme", return: true }, excerpt: "What" }] }] }], gaps: [] }),
      responseMetadata: { finishReason: "STOP" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    }) } });
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
    const rawJson = JSON.stringify({ contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" }, content: {
      roots: [{ act: "assertion", expression: { kind: "statement",
        predicate: { kind: "explicit", reading: "complete", support: { assertion_id: assertion.assertion_id, text: "completed" } },
        arguments: [{ role: "theme", target: { kind: "entity", key: "r0", mentions: [
          { assertion_id: assertion.assertion_id, text: "alpha" }] } }] } }] } });
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
      requestProfile: PROFILE, apiKey: "fixture" }, extractor: { extract: async () => ({
      rawJson: JSON.stringify({ contract: SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, semantic_correspondence: {
          contract: SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT, source_interpretation_handle: "source1",
          selections: [{ query: predicate.handle, source: frame.handle, query_excerpt: "completed",
            source_semantic_support: support.kind === "explicit" ? [{ kind: "lexical", mentions: support.mentions }] : [] },
          { query: slot.handle, source: sourceSlot.handle, query_excerpt: "What",
            source_semantic_support: sourceInterpretation.frames[0]!.slots[0]!.support }] } }),
      responseMetadata: { finishReason: "STOP" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    }) } });
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
    `I completed item ${index}. ` + Array.from({ length: 65 }, (_, part) => `Part ${part} occurred.`).join(" ")));
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
