import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT } from "@do-soul/alaya-soul";
import { SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT } from "@do-soul/alaya-protocol";
import { registerExtractionFillHooks, setExtractionCredentialFixture } from "../extraction-fill/fixture.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { prepareSourcePublicationAssociations } from "../../../runs/snapshot/source-records/prepare-associations.js";
import { parseSourcePublicationAssociations, publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { LongMemEvalNativeSemanticConfigSchema } from "../../../runs/longmemeval-semantic/contract.js";
import { prepareLongMemEvalSemanticRun, verifyLongMemEvalQuestionPublication } from "../../../runs/longmemeval-semantic/execute.js";
import { readChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";

const MODEL = "step-3.5-flash-2603";
const PROFILE = "step-3.5-2603-low-json-schema-v1" as const;
const CLOCK = "2026-09-23T00:00:00.000Z";
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), "longmemeval_s");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function question(id: string, themes: string[]) {
  return { question_id: id, question_type: "fixture", question: "Fixture query", answer: "unused fixture field",
    question_date: "2026-09-23", haystack_session_ids: themes.map(() => "shared-session"),
    haystack_dates: themes.map((_, index) => index === 0 ? "2023-09-10" : "2023-09-12"),
    haystack_sessions: themes.map((theme) => [{ role: "user" as const, content: `I completed ${theme}.` }]),
    answer_session_ids: [] };
}

function response(userPrompt: string) {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions[0]!;
  const theme = assertion.text.includes("alpha") ? "alpha" : "beta";
  return JSON.stringify({ contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" }, content: {
    roots: [{ act: "assertion", expression: { kind: "statement",
      predicate: { kind: "explicit", reading: "complete", support: { assertion_id: assertion.assertion_id, text: "completed" } },
      arguments: [{ role: "theme", target: { kind: "entity", key: "r0",
        mentions: [{ assertion_id: assertion.assertion_id, text: theme }] } }] } }]
  } });
}

async function prepareOwner(root: string, offset: number, retainedCap?: number) {
  const options = { variant: "longmemeval_s" as const, cacheRoot: root, dataDir, pinnedMetaRoot,
    offset, limit: 1, sourcePacking: "complete-source" as const,
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, concurrency: 1, log: () => undefined };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  const selected = inspection.missingKeys;
  expect(selected).toHaveLength(1);
  const preflight = await preflightSourceSemanticInteractive({ ...options, preflightKeys: selected });
  const retainedPreflight = retainedCap === undefined ? preflight :
    await preflightSourceSemanticInteractive({ ...options, preflightKeys: selected,
      preflightOutputTokenCap: retainedCap });
  const retainedPreparationPath = join(root, "retained-step-preflight.json");
  writeFileSync(retainedPreparationPath, JSON.stringify(retainedPreflight));
  const sampleScope = createExtractionSampleScope(selected, inspection);
  const receipt = createExtractionAuthorityReceipt({ action: "sample", sampleScope,
    observation: inspection.observation, inspection, maxConcurrency: 1,
    sourcePreflight: preflight,
    outputTokenCap: { field: "max_tokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
      outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const authorityReceiptPath = join(root, "fixture-authority.json");
  writeExtractionAuthorityReceipt(authorityReceiptPath, receipt);
  await runExtractionFill({ ...options, authorityReceiptPath });
  expect(inspectCachedSourceSemantic(root, selected[0]!, MODEL, PROFILE).status).toBe("hit");
  return { cacheRoot: root, retainedPreparationPath, preflight: retainedPreflight };
}

it("rejects a retained Step preparation whose selected cap differs from the source raw attempt", async () => {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  await writeDataset([question("one-owner", ["alpha"])]);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    expect(body).toMatchObject({ max_tokens: 4096 });
    const wire = `data: ${JSON.stringify({ choices: [{
      delta: { content: response(body.messages[1]!.content) }, finish_reason: "stop"
    }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`;
    return new Response(wire, { headers: { "content-type": "text/event-stream" } });
  }));
  const owner = await prepareOwner(cacheRoot, 0, 16384);
  expect(owner.preflight.max_output_tokens).toBe(16384);
  await expect(prepareSourcePublicationAssociations({ name: "longmemeval_s", dataDir, pinnedMetaRoot,
    model: MODEL, requestProfile: PROFILE, questionWindow: { offset: 0, limit: 1 } },
  [owner], join(cacheRoot, "mismatched-cap-associations.json"))).rejects.toThrow(/identity mismatch/u);
  writeFileSync(owner.retainedPreparationPath, JSON.stringify({ ...owner.preflight,
    contract: "source-semantic-interactive-preflight-v1" }));
  await expect(prepareSourcePublicationAssociations({ name: "longmemeval_s", dataDir, pinnedMetaRoot,
    model: MODEL, requestProfile: PROFILE, questionWindow: { offset: 0, limit: 1 } },
  [owner], join(cacheRoot, "stale-associations.json"))).rejects.toThrow();
});

it("joins two native Step owners for a later original question and retains unsupported source through SQLite reopen", async () => {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  const target = question("target", ["alpha", "beta"]);
  const longSession = [{ role: "user" as const, content: Array(32).fill("I completed alpha.").join(" ") },
    { role: "assistant" as const, content: [...Array(32).fill("Acknowledged."), "再次确认。"].join(" ") }];
  await writeDataset([question("alpha-owner", ["alpha"]), question("beta-owner", ["beta"]), {
    ...target, haystack_session_ids: [...target.haystack_session_ids, "long-session"],
    haystack_dates: [...target.haystack_dates, "2023-09-15"],
    haystack_sessions: [...target.haystack_sessions, longSession]
  }]);
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(String(url)).origin).toBe("https://api.stepfun.com");
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const wire = `data: ${JSON.stringify({ choices: [{ delta: { content: response(body.messages[1]!.content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`;
    return new Response(wire, { headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const betaRoot = join(cacheRoot, "beta-owner");
  mkdirSync(betaRoot);
  const first = await prepareOwner(cacheRoot, 0);
  const second = await prepareOwner(betaRoot, 1);
  expect(first.preflight.planned_requests[0]!.key).not.toBe(second.preflight.planned_requests[0]!.key);
  const owners = [first, second];
  const population = { name: "longmemeval_s", dataDir, pinnedMetaRoot, model: MODEL,
    requestProfile: PROFILE, questionWindow: { offset: 2, limit: 1 } };
  const out = join(cacheRoot, "target-step-associations.json");
  const associated = await prepareSourcePublicationAssociations(population, owners, out);
  expect(associated).toMatchObject({ contract: "source-publication-association-preparation-v3",
    source_occurrences: 3, unsupported_source_occurrences: 1, ready_request_keys: 2 });
  expect(associated.retained_preparations.map((owner) => owner.preparation_contract))
    .toEqual(["source-semantic-interactive-preflight-v2", "source-semantic-interactive-preflight-v2"]);
  const bindings = parseSourcePublicationAssociations(JSON.parse(readFileSync(`${out}.associations.json`, "utf8")));
  expect(bindings).toHaveLength(3);
  expect(bindings.find((binding) => "status" in binding)).toMatchObject({ source_id: "longmemeval_s:target-s2-r0",
    status: "unsupported_source", assertion_count: 65, provider_attempts: 0 });
  const census = await censusCompleteSourceRecords({ population: population.name, dataDir, pinnedMetaRoot,
    questionWindow: population.questionWindow });
  const freezeRoot = join(cacheRoot, "step-native-freeze");
  const frozen = await freezeLongMemEvalSemanticRun({ arm: "native_semantic", workspace_prefix: "step-root-composition-fixture",
    source_cache_roots: [cacheRoot, betaRoot], source_publication_associations: bindings,
    correspondence_cache_root: join(cacheRoot, "correspondence-cache"), discovery_page_cap: 4, correspondence_pair_cap: 2,
    authorized_scopes: { mode: "named", scopes: ["project"] }, data_dir: dataDir, pinned_meta_root: pinnedMetaRoot,
    dataset_sha256: census.dataset_sha256, dataset_question_count: 3, question_ids: ["target"],
    model: MODEL, provider_url: STEP_PLAN_QUOTE_BASIS.selected_provider_url, request_profile: PROFILE,
    query_cache_root: join(cacheRoot, "query-cache"), recorded_at: CLOCK, producer_commit: "a".repeat(40),
    max_output_tokens: 4096, output_byte_limit: 1000000,
    budget: { schema_version: 1, work_units: 1000000, memory_bytes: 60000000, page_budget: 100000,
      finalization_reserve: 10000, min_envelope: 10 } }, freezeRoot);
  expect(frozen.query_workset.contract).toBe("source-semantic-proposal-workset-v4");
  expect(frozen.selected).toHaveLength(1);
  expect(frozen.selected[0]!.source_manifest).toHaveLength(3);
  expect(materializeSemanticProposalLines(frozen.query_workset, 4096)[0]!.key).toBe(frozen.selected[0]!.query_key);
  expect(() => parseSemanticProposalWorkset({ ...frozen.query_workset,
    contract: "source-semantic-proposal-workset-v3" })).toThrow(/contract\/profile mismatch/u);
  const nativeConfig = LongMemEvalNativeSemanticConfigSchema.parse(frozen.config);
  const selected = frozen.selected[0]!;
  const directory = join(freezeRoot, "questions", "00002");
  const report = await publishSourceSemanticSnapshot({ snapshotPath: join(directory, "library.sqlite"),
    dataDirRoot: join(directory, "publication-runtime"), recordedAt: CLOCK, producerCommit: "a".repeat(40),
    workspaceId: "step-root-composition-fixture-2", runId: "step-root-composition-fixture-2",
    populations: [{ ...population, cacheRoots: [cacheRoot, betaRoot],
      publicationAssociations: nativeConfig.source_publication_associations.filter((row) =>
        selected.source_manifest.some((source) => source.source_id === row.source_id)) }] });
  expect(report).toMatchObject({ census_count: 3, admitted_count: 3, published_count: 2,
    host_preparation_counts: { ready: 2, unsupported_source: 1 }, source_interpretation_binding_complete: true });
  expect(report.sources.map((source) => source.question_id)).toEqual(["target", "target", "target"]);
  expect(verifyLongMemEvalQuestionPublication(frozen, selected, directory, report)).toEqual(report);
  expect(report.sources.map((source) => source.roles)).toEqual([["user"], ["user"], ["user", "assistant"]]);
  const db = new Database(report.snapshot_path, { readonly: true });
  try {
    expect(db.prepare("SELECT source_id, event_time, source_body FROM source_records ORDER BY source_id").all())
      .toEqual(census.records.map((source) => ({ source_id: source.source_id,
        event_time: source.source_observed_at, source_body: source.content_bytes })));
  } finally { db.close(); }
  const queryRawJson = JSON.stringify({ contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
    outcome: { status: "interpreted" }, query: { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
      requested_operation: { reading: "Fixture query", support: { kind: "query_text", excerpt: "Fixture query" } },
      alternatives: [{ conditions: [{ kind: "statement", key: "condition", predicate: "complete",
        arguments: [{ role: "theme", target: { kind: "free", key: "theme", return: true }, excerpt: "Fixture" }] }] }],
      gaps: [] } });
  const queryPreflight = prepareSemanticProposal(frozen.query_workset, frozen.config.query_cache_root, 4096, 1);
  const queryAuthority = pinSemanticProposalAuthority({ preflight: queryPreflight,
    inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
    outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million });
  const queryConfig = { providerUrl: STEP_PLAN_QUOTE_BASIS.selected_provider_url,
    model: MODEL, requestProfile: PROFILE, apiKey: "fixture" };
  const queryWire = `data: ${JSON.stringify({ choices: [{ delta: { content: queryRawJson }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`;
  const queryFetch = vi.fn<typeof fetch>(async (url) => {
    expect(String(url)).toBe("https://api.stepfun.com/step_plan/v1/chat/completions");
    return new Response(queryWire, { headers: { "content-type": "text/event-stream" } });
  });
  const queryFill = await executeSemanticProposalFill({ workset: frozen.query_workset,
    cacheRoot: frozen.config.query_cache_root, authority: queryAuthority,
    config: queryConfig,
    extractor: createSemanticProviderHttpExtractor(queryConfig, "source_semantic_proposal", queryFetch) });
  expect(queryFill.newly_admitted).toBe(1);
  expect(queryFetch).toHaveBeenCalledTimes(1);
  const prepared = await prepareLongMemEvalSemanticRun(freezeRoot);
  if (prepared.result.contract !== "longmemeval-native-semantic-prepared-v1") throw new Error("native preparation required");
  expect(prepared.result.rows).toMatchObject([{ question_id: "target", status: "prepared" }]);
  expect(prepared.result.correspondence_workset?.contract).toBe("source-semantic-proposal-workset-v4");
  expect(prepared.result.correspondence_workset?.items.length).toBeGreaterThan(0);
  expect(materializeSemanticProposalLines(prepared.result.correspondence_workset!, 4096)).not.toHaveLength(0);
  const row = prepared.result.rows[0]!;
  if (row.status !== "prepared") throw new Error(row.reason);
  expect(readChainArtifact(join(row.chain_root, "prepare.json"))).toMatchObject({
    config: { query_workset: { contract: "source-semantic-proposal-workset-v4" } },
    queries: [{ status: "ready" }], correspondence_workset: { contract: "source-semantic-proposal-workset-v4" } });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const rejected = join(cacheRoot, "rejected-step-associations.json");
  for (const modified of [
    { ...first.preflight, contract: "extraction-batch-preflight-v2" },
    { ...first.preflight, config: { ...first.preflight.config, requestProfile: "gemini-2.5-nonthinking-v1" } },
    { ...first.preflight, max_output_tokens: 8192 },
    { ...first.preflight, planned_requests: [{ ...first.preflight.planned_requests[0], request_digest: "f".repeat(64) }] }
  ]) {
    writeFileSync(first.retainedPreparationPath, JSON.stringify(modified));
    await expect(prepareSourcePublicationAssociations(population, owners, rejected)).rejects.toThrow();
    expect(existsSync(rejected)).toBe(false);
  }
  expect(fetchMock).toHaveBeenCalledTimes(2);
}, 60000);
