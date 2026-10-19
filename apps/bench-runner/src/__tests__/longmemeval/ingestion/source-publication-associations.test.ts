import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { buildSourceSemanticRequest, parseSourceSemanticRequest, prepareSourceSemanticRevision } from "@do-soul/alaya-soul";
import { registerExtractionFillHooks, setExtractionCredentialFixture } from "../extraction-fill/fixture.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { preflightExtractionBatch } from "../../../runs/extraction/fill/batch-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { prepareSourcePublicationAssociations } from "../../../runs/snapshot/source-records/prepare-associations.js";
import { parseSourcePublicationAssociations, publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { LongMemEvalNativeSemanticConfigSchema } from "../../../runs/longmemeval-semantic/contract.js";
import { verifyLongMemEvalQuestionPublication } from "../../../runs/longmemeval-semantic/execute.js";
import { readChainArtifact } from "../../../runs/recall-measurement/contract.js";

const MODEL = "gemini-2.5-flash-lite";
const REQUEST_PROFILE = "gemini-2.5-nonthinking-v1" as const;
const CLOCK = "2026-09-23T00:00:00.000Z";
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), "longmemeval_s");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function question(id: string, themes: string[]) {
  return { question_id: id, question_type: "fixture", question: "Fixture query", answer: "unused fixture field",
    question_date: "2026-09-23", haystack_session_ids: themes.map(() => "shared-session"),
    haystack_dates: themes.map((_, index) => index === 0 ? "2023-09-10" : "2023-09-12"),
    haystack_sessions: themes.map(theme => [{ role: "user" as const, content: `I completed ${theme}.` }]),
    answer_session_ids: [] };
}

function response(userPrompt: string) {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions[0]!;
  const theme = assertion.text.includes("alpha") ? "alpha" : "beta";
  return JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" }, content: {
    roots: [{ act: "assertion", expression: { kind: "content_ref", key: "completion" } }],
    entities: [{ form: "entity", key: "r0", semantic_key: "r0",
      mentions: [{ assertion_id: assertion.assertion_id, text: theme }] }],
    nodes: [{ kind: "statement", key: "completion",
      predicate: { kind: "explicit", reading: "complete", support: { assertion_id: assertion.assertion_id, text: "completed" } },
      arguments: [{ role: "theme", target: { kind: "entity_ref", key: "r0" } }], qualifications: [] }], gaps: []
  } });
}

async function fixture(revised = false) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  await writeDataset([question("outside", ["alpha"]), question("repeated", ["alpha", "alpha"]), question("unique", ["beta"])]);
  const options = { variant: "longmemeval_s" as const, cacheRoot, dataDir, pinnedMetaRoot,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const batch = { operation: "prepare" as const, limits: { maxJobs: 1, maxRequestsPerJob: 100, maxFileBytes: 1000000,
    maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000, maxOutputTokens: 4096, maxUsd: 1,
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 } };
  const base = await preflightExtractionBatch({ ...options, batch });
  const generation = revised ? { ...EXTRACTION_OPEN_SEMANTICS_GENERATION, revisions: base.planned_requests.map(line =>
    prepareSourceSemanticRevision(parseSourceSemanticRequest(JSON.parse(line.userPrompt)), "invalid JSON", [], { responseCompletion: "complete" })) }
    : EXTRACTION_OPEN_SEMANTICS_GENERATION;
  const preflight = revised ? await preflightExtractionBatch({ ...options, openSemantics: generation, batch }) : base;
  const preflightPath = join(cacheRoot, "preflight.json");
  writeFileSync(preflightPath, JSON.stringify(preflight));
  const inspection = await inspectExtractionAuthority({ ...options, openSemantics: generation,
    revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 }, inspection });
  const authorityReceiptPath = join(cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(authorityReceiptPath, receipt);
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (!new URL(String(url)).pathname.endsWith(":streamGenerateContent")) throw new Error("unexpected fixture transport");
    const userPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: response(userPrompt) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await runExtractionFill({ ...options, openSemantics: generation, authorityReceiptPath });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const line of preflight.planned_requests) expect(inspectCachedSourceSemantic(cacheRoot, line.key, MODEL, REQUEST_PROFILE).status).toBe("hit");
  const population = { name: "fixture", dataDir, pinnedMetaRoot, model: MODEL, requestProfile: REQUEST_PROFILE };
  return { population, preflight, preflightPath, preflightOptions: { ...options, openSemantics: generation, batch },
    generation, fetchMock };
}

async function prepareWindowOwner(root: string, offset: number) {
  const options = { variant: "longmemeval_s" as const, cacheRoot: root, dataDir, pinnedMetaRoot,
    offset, limit: 1, sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const preflight = await preflightExtractionBatch({ ...options, batch: { operation: "prepare", limits: {
    maxJobs: 1, maxRequestsPerJob: 10, maxFileBytes: 1000000, maxInputTokensPerJob: 1000000,
    maxEnqueuedTokens: 1000000, maxOutputTokens: 4096, maxUsd: 1,
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10
  } } });
  const retainedPreparationPath = join(root, "preflight.json");
  writeFileSync(retainedPreparationPath, JSON.stringify(preflight));
  const inspection = await inspectExtractionAuthority({ ...options,
    revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 }, inspection });
  const authorityReceiptPath = join(root, "authority.json");
  writeExtractionAuthorityReceipt(authorityReceiptPath, receipt);
  await runExtractionFill({ ...options, authorityReceiptPath });
  return { cacheRoot: root, retainedPreparationPath, preflight };
}

it("prepares a fixed window and publishes one admitted interpretation at both original positions and dates", async () => {
  const f = await fixture();
  const population = { ...f.population, questionWindow: { offset: 1, limit: 1 } };
  const config = join(cacheRoot, "association-config.json"), out = join(cacheRoot, "prepared.json");
  writeFileSync(config, JSON.stringify({ ...population,
    cacheOwners: [{ cacheRoot, retainedPreparationPath: f.preflightPath }] }));
  const retained = [f.preflightPath, join(cacheRoot, "manifest.json"), ...f.preflight.planned_requests.map(line => cacheFilePath(cacheRoot, line.key))];
  const before = retained.map(path => readFileSync(path, "utf8"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await prepareSourcePublicationAssociations(population,
    [{ cacheRoot, retainedPreparationPath: f.preflightPath }], out);
  const sidecar = JSON.parse(readFileSync(`${out}.associations.json`, "utf8"));
  expect(sidecar.contract).toBe("source-publication-associations-v2");
  const associations = sidecar.publicationAssociations;
  expect(associations.map((row: { source_id: string }) => row.source_id)).toEqual(["fixture:repeated-s0-r0", "fixture:repeated-s1-r0"]);
  expect(new Set(associations.map((row: { generation_key: string }) => row.generation_key)).size).toBe(1);
  expect(new Set(associations.map((row: { request_digest: string }) => row.request_digest)).size).toBe(1);
  const report = await publishSourceSemanticSnapshot({ snapshotPath: join(cacheRoot, "published.sqlite"),
    dataDirRoot: join(cacheRoot, "publication"), recordedAt: CLOCK, producerCommit: "a".repeat(40),
    populations: [{ ...population, cacheRoots: [cacheRoot], publicationAssociations: associations }] });
  expect(report).toMatchObject({ census_count: 2, published_count: 2, source_interpretation_binding_complete: false });
  expect(report.unbound_source_interpretation_artifacts).toHaveLength(1);
  expect(report.unbound_source_interpretation_artifacts[0]!.status).toBe("unbound");
  expect(report.sources.every(row => row.source_interpretation_binding?.kind === "host_publication_association")).toBe(true);
  for (const field of ["record_id", "interpretation_id", "evidence_object_id"] as const) {
    expect(report.sources.every(row => row[field] !== undefined)).toBe(true);
    expect(new Set(report.sources.map(row => row[field])).size).toBe(2);
  }
  for (let reopen = 0; reopen < 2; reopen++) {
    const db = new Database(report.snapshot_path, { readonly: true });
    try {
      expect(db.prepare("SELECT source_id, source_version, source_body, event_time, recorded_at FROM source_records ORDER BY source_id").all())
        .toEqual(["2023-09-10T00:00:00.000Z", "2023-09-12T00:00:00.000Z"].map((event_time, index) => ({
          source_id: `fixture:repeated-s${index}-r0`, source_version: associations[index].source_version,
          source_body: "User: I completed alpha.", event_time, recorded_at: CLOCK })));
      for (const [index, source] of report.sources.entries()) {
        const evidence = db.prepare("SELECT gist FROM evidence_capsules WHERE object_id = ?").get(source.evidence_object_id) as { gist: string };
        expect(JSON.parse(evidence.gist)).toMatchObject({
          interpretation_id: source.interpretation_id, source_target: { root_id: source.record_id },
          interpretation: { source: { source_id: `fixture:repeated-s${index}-r0`, source_version: associations[index].source_version } }
        });
      }
    } finally { db.close(); }
  }
  expect(retained.map(path => readFileSync(path, "utf8"))).toEqual(before);
  expect(f.fetchMock).toHaveBeenCalledTimes(2);
}, 60000);

it("associates unique and repeated occurrences with only the independently configured request generation", async () => {
  const f = await fixture(true);
  const owner = [{ cacheRoot, retainedPreparationPath: f.preflightPath }];
  const unmatched = await prepareSourcePublicationAssociations(f.population, owner, join(cacheRoot, "unmatched.json"));
  expect(unmatched.publicationAssociations).toEqual([]);
  expect(unmatched.artifacts.every(row => row.status === "unbound")).toBe(true);
  expect(unmatched.sources).toHaveLength(4);
  expect(unmatched.sources.every(row => row.reason === "missing_current_artifact")).toBe(true);
  const matched = await prepareSourcePublicationAssociations({ ...f.population, openSemantics: f.generation }, owner, join(cacheRoot, "matched.json"));
  expect(matched.publicationAssociations.map(row => row.source_id).sort()).toEqual([
    "fixture:outside-s0-r0", "fixture:repeated-s0-r0", "fixture:repeated-s1-r0", "fixture:unique-s0-r0"
  ]);
  expect(matched.artifacts).toHaveLength(2);
  expect(matched.artifacts.every(row => row.status === "associated")).toBe(true);
  expect(f.fetchMock).toHaveBeenCalledTimes(2);
}, 60000);

it("selects one natural source revision by its exact current content tuple", async () => {
  const f = await fixture(true);
  const census = await censusCompleteSourceRecords({ population: f.population.name, dataDir, pinnedMetaRoot });
  const unique = census.records.find(row => row.question_id === "unique")!;
  const child = f.preflight.planned_requests.find(line => line.userPrompt.includes("beta"))!;
  const selected = { kind: "natural" as const, source_id: unique.source_id,
    source_version: unique.source_version, content_digest: unique.content_digest,
    key: child.key, generation: f.generation };
  const owners = [{ cacheRoot, retainedPreparationPath: f.preflightPath }];
  const actual = await prepareSourcePublicationAssociations({ ...f.population,
    activeRevision: selected }, owners, join(cacheRoot, "natural-revision.json"));
  expect(actual.publicationAssociations.map(row => row.source_id)).toEqual([unique.source_id]);
  await expect(prepareSourcePublicationAssociations({ ...f.population,
    activeRevision: { ...selected, content_digest: "sha256:changed" } }, owners,
  join(cacheRoot, "foreign-natural-revision.json"))).rejects.toThrow(/one current source tuple/u);
}, 60000);

it("keeps invalid artifacts, missing artifacts, and missing retained request proof explicitly unassociated", async () => {
  const f = await fixture();
  const warmPreflight = await preflightExtractionBatch(f.preflightOptions);
  expect(warmPreflight.planned_requests).toEqual([]);
  expect(warmPreflight.cached_requests).toBe(2);
  writeFileSync(f.preflightPath, JSON.stringify(warmPreflight));
  const owner = [{ cacheRoot, retainedPreparationPath: f.preflightPath }];
  const unproven = await prepareSourcePublicationAssociations(f.population, owner, join(cacheRoot, "unproven.json"));
  expect(unproven.publicationAssociations).toEqual([]);
  expect(unproven.sources.every(row => row.reason === "unproven_retained_request")).toBe(true);
  writeFileSync(f.preflightPath, JSON.stringify(f.preflight));
  const [invalid, missing] = f.preflight.planned_requests;
  writeFileSync(cacheFilePath(cacheRoot, invalid!.key), "{}");
  unlinkSync(cacheFilePath(cacheRoot, missing!.key));
  const unavailable = await prepareSourcePublicationAssociations(f.population, owner, join(cacheRoot, "unavailable.json"));
  expect(unavailable.publicationAssociations).toEqual([]);
  expect(unavailable.sources).toHaveLength(4);
  expect(new Set(unavailable.sources.map(row => row.reason))).toEqual(new Set(["invalid_current_artifact", "missing_current_artifact"]));
  expect(unavailable.artifacts).toEqual([{ key: invalid!.key, cache_root: cacheRoot, status: "invalid", sources: [] }]);
  expect(f.fetchMock).toHaveBeenCalledTimes(2);
}, 60000);

it("rejects duplicate or foreign retained request identity before writing associations", async () => {
  const f = await fixture();
  const line = f.preflight.planned_requests[0]!;
  for (const planned_requests of [[line, line], [{ ...line, requestSha256: "a".repeat(64) }]]) {
    writeFileSync(f.preflightPath, JSON.stringify({ ...f.preflight, planned_requests }));
    const out = join(cacheRoot, "rejected.json");
    await expect(prepareSourcePublicationAssociations(f.population, [{ cacheRoot, retainedPreparationPath: f.preflightPath }], out))
      .rejects.toThrow(/invalid or duplicate Batch line identity|retained Batch preflight differs from its native plan/u);
    expect(existsSync(out)).toBe(false);
  }
  const config = join(cacheRoot, "invalid-window.json");
  writeFileSync(config, JSON.stringify({ ...f.population, questionWindow: { offset: -1, limit: 1 },
    cacheOwners: [{ cacheRoot, retainedPreparationPath: f.preflightPath }] }));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await expect(prepareSourcePublicationAssociations({ ...f.population, questionWindow: { offset: -1, limit: 1 } },
    [{ cacheRoot, retainedPreparationPath: f.preflightPath }], join(cacheRoot, "bad.json"))).rejects.toThrow();
  expect(existsSync(join(cacheRoot, "bad.json"))).toBe(false);
  writeFileSync(f.preflightPath, JSON.stringify(f.preflight));
  const duplicateBucket = join(cacheRoot, line.key.startsWith("ff") ? "ee" : "ff");
  mkdirSync(duplicateBucket, { recursive: true });
  writeFileSync(join(duplicateBucket, `${line.key}.json`), readFileSync(cacheFilePath(cacheRoot, line.key)));
  await expect(prepareSourcePublicationAssociations(f.population,
    [{ cacheRoot, retainedPreparationPath: f.preflightPath }], join(cacheRoot, "duplicate-owner.json")))
    .rejects.toThrow("repeats an owning request key");
  expect(existsSync(join(cacheRoot, "duplicate-owner.json"))).toBe(false);
}, 60000);

it("retains a 129-unit source beside a ready 128-unit source through association and SQLite reopen", async () => {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  const fetchGuard = vi.fn<typeof fetch>(async () => { throw new Error("provider use forbidden"); });
  vi.stubGlobal("fetch", fetchGuard);
  const longQuestion = (id: string, assistantCount: number) => ({ ...question(id, []),
    haystack_session_ids: ["shared-session"], haystack_dates: ["2023-09-10"],
    haystack_sessions: [[{ role: "user" as const, content: Array(64).fill("I completed alpha.").join(" ") },
      { role: "assistant" as const, content: [
        ...Array(assistantCount - 1).fill("Acknowledged."), "再次确认。"
      ].join(" ") }]] });
  await writeDataset([longQuestion("ready", 64), longQuestion("excess", 65)]);
  const population = { name: "fixture", dataDir, pinnedMetaRoot,
    model: MODEL, requestProfile: REQUEST_PROFILE };
  const census = await censusCompleteSourceRecords({ population: population.name, dataDir, pinnedMetaRoot });
  expect(census.records.map((source) => source.units.length)).toEqual([128, 129]);
  const preflight = await preflightExtractionBatch({ variant: "longmemeval_s", cacheRoot, dataDir, pinnedMetaRoot,
    sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    batch: { operation: "prepare", limits: { maxJobs: 1, maxRequestsPerJob: 10, maxFileBytes: 1000000,
      maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000, maxOutputTokens: 4096, maxUsd: 10,
      inputUsdPerMillion: 1, outputUsdPerMillion: 2, deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 } } });
  expect(preflight).toMatchObject({ contract: "extraction-batch-preflight-v2", provider_calls: 0,
    source_occurrences: 2, unsupported_source_occurrences: 1, total_requests: 1, selected_requests: 1 });
  expect(preflight.unsupported_sources).toMatchObject([{ status: "unsupported_source", assertion_count: 129,
    reason: { dimension: "assertions", actual: 129, limit: 128 }, provider_attempts: 0 }]);
  expect(preflight.planned_requests).toHaveLength(1);
  const preflightPath = join(cacheRoot, "mixed-preflight.json");
  writeFileSync(preflightPath, JSON.stringify(preflight));
  const outputPath = join(cacheRoot, "mixed-associations.json");
  const association = await prepareSourcePublicationAssociations(population, [{ cacheRoot, retainedPreparationPath: preflightPath }], outputPath);
  expect(association).toMatchObject({ contract: "source-publication-association-preparation-v3",
    source_occurrences: 2, unsupported_source_occurrences: 1, ready_request_keys: 1 });
  expect(association.sources.map((source) => source.status)).toEqual(["unbound", "unsupported_source"]);
  const bindings = parseSourcePublicationAssociations(JSON.parse(readFileSync(`${outputPath}.associations.json`, "utf8")));
  expect(bindings).toHaveLength(1);
  expect(bindings.filter((binding) => "generation_key" in binding)).toHaveLength(0);
  const unsupported = bindings.find((binding) => "status" in binding)!;
  await expect(publishSourceSemanticSnapshot({ snapshotPath: join(cacheRoot, "tampered.sqlite"),
    dataDirRoot: join(cacheRoot, "tampered-publication"), recordedAt: CLOCK, producerCommit: "a".repeat(40),
    populations: [{ ...population, cacheRoots: [cacheRoot], publicationAssociations: bindings.map((binding) =>
      binding === unsupported ? { ...binding, source_digest: "a".repeat(64) } : binding) }] }))
    .rejects.toThrow(/unsupported source disposition/u);
  expect(existsSync(join(cacheRoot, "tampered.sqlite"))).toBe(false);
  const report = await publishSourceSemanticSnapshot({ snapshotPath: join(cacheRoot, "mixed.sqlite"),
    dataDirRoot: join(cacheRoot, "mixed-publication"), recordedAt: CLOCK, producerCommit: "a".repeat(40),
    populations: [{ ...population, cacheRoots: [cacheRoot], publicationAssociations: bindings }] });
  expect(report).toMatchObject({ schema_version: 3, census_count: 2, admitted_count: 2,
    published_count: 0, host_preparation_counts: { ready: 1, unsupported_source: 1 } });
  expect(report.sources[1]).toMatchObject({ source_interpretation: "absent", publication: "not_attempted",
    host_preparation: { status: "unsupported_source" }, provider_attempts: 0 });
  const db = new Database(report.snapshot_path, { readonly: true });
  try {
    expect(db.prepare("SELECT source_id, source_version, source_body FROM source_records ORDER BY source_id").all())
      .toEqual(census.records.slice().sort((a, b) => a.source_id.localeCompare(b.source_id)).map((source) => ({
        source_id: source.source_id, source_version: source.source_version, source_body: source.content_bytes
      })));
  } finally { db.close(); }
  expect(fetchGuard).not.toHaveBeenCalled();
}, 60000);

it("reads a historical capacity refusal without republishing a source now within capacity", async () => {
  setExtractionCredentialFixture();
  const fetchGuard = vi.fn<typeof fetch>(async () => { throw new Error("provider use forbidden"); });
  vi.stubGlobal("fetch", fetchGuard);
  const item = question("historical-capacity", ["alpha"]);
  item.haystack_sessions[0]![0]!.content = Array.from({ length: 65 }, (_, i) => `Item ${i} is recorded.`).join(" ");
  await writeDataset([item]);
  const population = { name: "fixture", dataDir, pinnedMetaRoot, model: MODEL, requestProfile: REQUEST_PROFILE };
  const census = await censusCompleteSourceRecords({ population: population.name, dataDir, pinnedMetaRoot });
  const source = census.records[0]!;
  expect(source.units).toHaveLength(65);
  const request = buildSourceSemanticRequest({ sourceCorpus: source.content_bytes,
    assertionIds: source.units.map(unit => unit.assertion_id), sourceScope: "complete-source",
    source_id: source.source_id, source_version: source.source_version,
    producer_id: "authored-history", producer_version: "1" });
  const body = request.source_request;
  const historical = { source_id: source.source_id, source_version: source.source_version,
    content_digest: source.content_digest, corpus_digest: source.corpus_digest,
    status: "unsupported_source", source_digest: request.source_digest, source_scope: "complete-source",
    source_unit_contract: body.source_unit_contract, interpretation_contract: request.interpretation_contract,
    k_version: body.k_version, normalizer_version: body.normalizer_version,
    proposal_contract: body.proposal_contract, generation_schema_contract: body.generation_schema_contract,
    assertion_count: 65, reason: { dimension: "assertions", actual: 65, limit: 64 }, provider_attempts: 0 };
  const bindings = parseSourcePublicationAssociations({ contract: "source-publication-associations-v2",
    publicationAssociations: [historical] });
  expect(bindings).toEqual([historical]);
  const snapshotPath = join(cacheRoot, "historical.sqlite");
  await expect(publishSourceSemanticSnapshot({ snapshotPath,
    dataDirRoot: join(cacheRoot, "historical-publication"), recordedAt: CLOCK, producerCommit: "a".repeat(40),
    populations: [{ ...population, publicationAssociations: bindings }] }))
    .rejects.toThrow(/retained unsupported source disposition differs/u);
  expect(bindings).toEqual([historical]);
  expect(existsSync(snapshotPath)).toBe(false);
  expect(fetchGuard).not.toHaveBeenCalled();
}, 60000);

it("composes earlier and current owning roots for one original question with unsupported source through native publication", async () => {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  const target = question("target", ["alpha", "beta"]);
  const longSession = [{ role: "user" as const, content: Array(64).fill("I completed alpha.").join(" ") },
    { role: "assistant" as const, content: [...Array(64).fill("Acknowledged."), "再次确认。"].join(" ") }];
  await writeDataset([question("alpha-owner", ["alpha"]), question("beta-owner", ["beta"]), {
    ...target, haystack_session_ids: [...target.haystack_session_ids, "long-session"],
    haystack_dates: [...target.haystack_dates, "2023-09-15"],
    haystack_sessions: [...target.haystack_sessions, longSession]
  }]);
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (!new URL(String(url)).pathname.endsWith(":streamGenerateContent")) throw new Error("unexpected fixture transport");
    const userPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: response(userPrompt) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const betaRoot = join(cacheRoot, "beta-owner");
  mkdirSync(betaRoot);
  const first = await prepareWindowOwner(cacheRoot, 0);
  const second = await prepareWindowOwner(betaRoot, 1);
  expect(first.preflight.planned_requests).toHaveLength(1);
  expect(second.preflight.planned_requests).toHaveLength(1);
  expect(first.preflight.planned_requests[0]!.key).not.toBe(second.preflight.planned_requests[0]!.key);
  const owners = [first, second];
  const population = { name: "longmemeval_s", dataDir, pinnedMetaRoot, model: MODEL,
    requestProfile: REQUEST_PROFILE, questionWindow: { offset: 2, limit: 1 } };
  const config = join(cacheRoot, "target-config.json"), out = join(cacheRoot, "target-associations.json");
  writeFileSync(config, JSON.stringify({ ...population, cacheOwners: owners.map(({ cacheRoot, retainedPreparationPath }) =>
    ({ cacheRoot, retainedPreparationPath })) }));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await prepareSourcePublicationAssociations(population, owners, out);
  const result = readChainArtifact(out) as { source_occurrences: number; unsupported_source_occurrences: number;
    ready_request_keys: number; sources: { status: string }[] };
  const associations = parseSourcePublicationAssociations(JSON.parse(readFileSync(`${out}.associations.json`, "utf8")));
  expect(result).toMatchObject({ source_occurrences: 3, unsupported_source_occurrences: 1,
    ready_request_keys: 2 });
  expect(result.sources.map((source: { status: string }) => source.status)).toEqual(["associated", "associated", "unsupported_source"]);
  expect(associations).toHaveLength(3);
  expect(associations.filter((row) => "generation_key" in row).map((row) => row.source_id)).toEqual([
    "longmemeval_s:target-s0-r0", "longmemeval_s:target-s1-r0"
  ]);
  expect(associations.find((row) => "status" in row)).toMatchObject({ source_id: "longmemeval_s:target-s2-r0",
    status: "unsupported_source", assertion_count: 129, provider_attempts: 0 });
  const earlier = await prepareSourcePublicationAssociations({ ...population, questionWindow: { offset: 0, limit: 1 } },
    owners, join(cacheRoot, "earlier-associations.json"));
  const census = await censusCompleteSourceRecords({ population: population.name, dataDir, pinnedMetaRoot,
    questionWindow: population.questionWindow });
  const freezeRoot = join(cacheRoot, "native-freeze");
  const frozen = await freezeLongMemEvalSemanticRun({ arm: "native_semantic", workspace_prefix: "root-composition-fixture",
    source_cache_roots: [cacheRoot, betaRoot], source_publication_associations: [...associations, ...earlier.publicationAssociations],
    correspondence_cache_root: join(cacheRoot, "correspondence-cache"), discovery_page_cap: 4, correspondence_pair_cap: 2,
    authorized_scopes: { mode: "named", scopes: ["project"] }, data_dir: dataDir, pinned_meta_root: pinnedMetaRoot,
    dataset_sha256: census.dataset_sha256, dataset_question_count: 3, question_ids: ["target"],
    model: MODEL, provider_url: "http://127.0.0.1:9", request_profile: REQUEST_PROFILE,
    query_cache_root: join(cacheRoot, "query-cache"), recorded_at: CLOCK, producer_commit: "a".repeat(40),
    max_output_tokens: 4096, output_byte_limit: 1000000,
    budget: { schema_version: 1, work_units: 1000000, memory_bytes: 60000000, page_budget: 100000,
      finalization_reserve: 10000, min_envelope: 10 } }, freezeRoot);
  expect(frozen.selected).toHaveLength(1);
  expect(frozen.selected[0]!.source_manifest).toHaveLength(3);
  const nativeConfig = LongMemEvalNativeSemanticConfigSchema.parse(frozen.config);
  const selected = frozen.selected[0]!;
  const directory = join(freezeRoot, "questions", "00002");
  const report = await publishSourceSemanticSnapshot({ snapshotPath: join(directory, "library.sqlite"),
    dataDirRoot: join(directory, "publication-runtime"), recordedAt: CLOCK, producerCommit: "a".repeat(40),
    workspaceId: "root-composition-fixture-2", runId: "root-composition-fixture-2",
    populations: [{ ...population, cacheRoots: [cacheRoot, betaRoot],
      publicationAssociations: nativeConfig.source_publication_associations.filter((row) =>
        selected.source_manifest.some((source) => source.source_id === row.source_id)) }] });
  expect(report).toMatchObject({ census_count: 3, admitted_count: 3, published_count: 2,
    host_preparation_counts: { ready: 2, unsupported_source: 1 }, source_interpretation_binding_complete: true });
  expect(verifyLongMemEvalQuestionPublication(frozen, selected, directory, report)).toEqual(report);
  expect(report.sources.map((source) => source.roles)).toEqual([["user"], ["user"], ["user", "assistant"]]);
  const db = new Database(report.snapshot_path, { readonly: true });
  try {
    expect(db.prepare("SELECT source_id, event_time, source_body FROM source_records ORDER BY source_id").all())
      .toEqual(census.records.map((source) => ({ source_id: source.source_id,
        event_time: source.source_observed_at, source_body: source.content_bytes })));
  } finally { db.close(); }
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const rejected = join(cacheRoot, "rejected-composition.json");
  await expect(prepareSourcePublicationAssociations(population, [first,
    { ...second, cacheRoot: cacheRoot + "/./" }], rejected)).rejects.toThrow("repeats a resolved cache root");
  expect(existsSync(rejected)).toBe(false);
  const alphaKey = first.preflight.planned_requests[0]!.key;
  const alphaPath = cacheFilePath(cacheRoot, alphaKey);
  const foreignPath = cacheFilePath(betaRoot, alphaKey);
  mkdirSync(join(betaRoot, alphaKey.slice(0, 2)), { recursive: true });
  copyFileSync(alphaPath, foreignPath);
  await expect(prepareSourcePublicationAssociations(population, owners, rejected))
    .rejects.toThrow("multiple physical cache roots");
  expect(existsSync(rejected)).toBe(false);
  unlinkSync(foreignPath);
  const duplicateRoot = join(cacheRoot, "duplicate-report-root");
  mkdirSync(duplicateRoot);
  const duplicateOptions = { variant: "longmemeval_s" as const, cacheRoot: duplicateRoot, dataDir, pinnedMetaRoot,
    offset: 0, limit: 1, sourcePacking: "complete-source" as const,
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    batch: { operation: "prepare" as const, limits: first.preflight.limits } };
  const duplicatePath = join(duplicateRoot, "preflight.json");
  const duplicateOwner = [{ cacheRoot, retainedPreparationPath: first.retainedPreparationPath },
    { cacheRoot: duplicateRoot, retainedPreparationPath: duplicatePath }];
  const sameRequest = await preflightExtractionBatch(duplicateOptions);
  expect(sameRequest.planned_requests[0]?.key).toBe(alphaKey);
  writeFileSync(duplicatePath, JSON.stringify(sameRequest));
  await expect(prepareSourcePublicationAssociations(population, duplicateOwner, rejected))
    .rejects.toThrow("repeat an owning request key");
  expect(existsSync(rejected)).toBe(false);
  const revisedGeneration = { ...EXTRACTION_OPEN_SEMANTICS_GENERATION, revisions: [prepareSourceSemanticRevision(
    parseSourceSemanticRequest(JSON.parse(first.preflight.planned_requests[0]!.userPrompt)),
    "invalid JSON", [], { responseCompletion: "complete" })] };
  const sameOccurrence = await preflightExtractionBatch({ ...duplicateOptions, openSemantics: revisedGeneration });
  expect(sameOccurrence.planned_requests[0]?.key).not.toBe(alphaKey);
  expect(sameOccurrence.planned_requests[0]?.unitKeys).toEqual(first.preflight.planned_requests[0]?.unitKeys);
  writeFileSync(duplicatePath, JSON.stringify(sameOccurrence));
  await expect(prepareSourcePublicationAssociations(population, duplicateOwner, rejected))
    .rejects.toThrow("retained source overlap lacks a complete immediate parent");
  expect(existsSync(rejected)).toBe(false);
  renameSync(alphaPath, foreignPath);
  const displaced = await prepareSourcePublicationAssociations(population, owners, join(cacheRoot, "displaced.json"));
  expect(displaced.sources[0]).toMatchObject({ status: "unbound", reason: "missing_current_artifact" });
  expect(displaced.artifacts.find((artifact) => artifact.key === alphaKey)).toMatchObject({
    cache_root: betaRoot, reason: "foreign_root" });
  renameSync(foreignPath, alphaPath);
  const alphaBytes = readFileSync(alphaPath);
  writeFileSync(alphaPath, "{}");
  const invalid = await prepareSourcePublicationAssociations(population, owners, join(cacheRoot, "invalid-owner.json"));
  expect(invalid.sources[0]).toMatchObject({ status: "unbound", reason: "invalid_current_artifact" });
  writeFileSync(alphaPath, alphaBytes);
  const originalFirstPreflight = readFileSync(first.retainedPreparationPath, "utf8");
  const warmFirst = await preflightExtractionBatch({ variant: "longmemeval_s", cacheRoot, dataDir, pinnedMetaRoot,
    offset: 0, limit: 1, sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    batch: { operation: "prepare", limits: first.preflight.limits } });
  expect(warmFirst.planned_requests).toEqual([]);
  writeFileSync(first.retainedPreparationPath, JSON.stringify(warmFirst));
  const unproven = await prepareSourcePublicationAssociations(population, owners, join(cacheRoot, "unproven-owner.json"));
  expect(unproven.sources[0]).toMatchObject({ status: "unbound", reason: "unproven_retained_request" });
  writeFileSync(first.retainedPreparationPath, originalFirstPreflight);
  expect(fetchMock).toHaveBeenCalledTimes(2);
}, 60000);
