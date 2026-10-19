import { dirname, join } from "node:path";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const [{ default: fs }, { default: fsp }, { syncBuiltinESMExports }] =
    await Promise.all([import("node:fs"), import("node:fs/promises"), import("node:module")]);
  const restores: (() => void)[] = [], forbidden: string[] = [];
  const deny = (kind: string) => { forbidden.push(kind); throw new Error(`Provider-free source test forbids ${kind}`); };
  for (const name of ["node:http", "node:https", "node:net", "node:tls", "node:http2", "node:dgram"]) {
    const owner = (await import(name)).default;
    for (const key of ["request", "get", "connect", "createConnection", "createSocket"]) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (typeof descriptor?.value !== "function") continue;
      Object.defineProperty(owner, key, { ...descriptor, value: () => deny(name) });
      restores.push(() => Object.defineProperty(owner, key, descriptor));
    }
  }
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = () => deny("fetch");
  restores.push(() => { globalThis.fetch = nativeFetch; });
  const environment = process.env;
  const guardedEnvironment = Object.fromEntries(Object.keys(environment)
    .filter(key => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)).map(key => [key, environment[key]]));
  // Native daemon fixtures may set their own local authentication after real credentials are removed.
  process.env = guardedEnvironment;
  restores.push(() => { process.env = environment; });
  for (const owner of [fs, fsp]) for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (typeof descriptor?.value !== "function") continue;
    Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
      apply(target, receiver, args) {
        const filename = String(args[0]);
        const nativeFixtureConfig = /[/\\]alaya-bench-config-[a-f0-9-]+[/\\]\.env(?:\.[a-f0-9-]+\.tmp)?$/u.test(filename);
        if (!nativeFixtureConfig && /(?:^|[/\\])(?:[^/\\]+\.env|\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(filename)) return deny(`credential file ${filename}`);
        return Reflect.apply(target, receiver, args);
      }
    }) });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  syncBuiltinESMExports();
  return { forbidden, restore: () => { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); } };
});
afterAll(() => { isolation.restore(); expect(isolation.forbidden).toEqual([]); });
import { parseExtractionSampleKeys } from "../../../runs/extraction/authority/sample-scope.js";
import { registerExtractionFillHooks } from "./fixture.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, prepareSourceSemanticRequestLine,
  sourceSemanticArtifactPreparations, type ExtractionOpenSemanticsGeneration } from "../../../runs/extraction/request-artifact.js";
import { parseSourceSemanticInteractivePreflight, preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { prepareLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/execute.js";
import { writeLongMemEvalLazyConfig } from "../../../runs/semantic-chain/longmemeval-lazy-config.js";
import { admitNativeLazyConfig } from "../../../runs/semantic-chain/bind-lazy.js";
import { prepareLazyQualificationWindow, admitLazyWindow, sealLazyQualificationFinal,
  replayLazyQualifiedFirstExposure } from "../../../runs/semantic-chain/lazy-qualification.js";
import { SemanticChainPlanSchema, readChainArtifact, writeChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import type { LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";

const MODEL = "step-3.5-flash-2603";
const PROFILE = "step-3.5-2603-low-json-schema-v1" as const;
const ORIGINAL_QUERY = "What was completed?";
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks(roots => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), "longmemeval_s");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function generation(query = ORIGINAL_QUERY): ExtractionOpenSemanticsGeneration {
  return { ...EXTRACTION_OPEN_SEMANTICS_GENERATION, generation_task: {
    contract: "source-semantic-generation-task-v1", context: "complete_original_source", original_query: query,
    responsibility: { kind: "original_query_task", other_meaning: "unassessed" }
  } };
}

async function nativeQuestion() {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  const fetch = vi.fn(async () => { throw new Error("bounded source test denies provider requests"); });
  vi.stubGlobal("fetch", fetch);
  const question: LongMemEvalQuestion = { question_id: "bounded-native", question_type: "single_session",
    question: ORIGINAL_QUERY, answer: "unused", question_date: "2026-09-23",
    haystack_session_ids: Array.from({ length: 12 }, (_, index) => `session-${index}`),
    haystack_dates: Array.from({ length: 12 }, () => "2023-09-10"),
    haystack_sessions: Array.from({ length: 12 }, (_, index) => [{ role: "user", content: `I completed item ${index}.` }]),
    answer_session_ids: [] };
  await writeDataset([question]);
  const population = { name: "longmemeval_s", dataDir, pinnedMetaRoot, questionWindow: { offset: 0, limit: 1 as const } };
  const census = await censusCompleteSourceRecords({ population: population.name, dataDir, pinnedMetaRoot,
    questionWindow: population.questionWindow });
  const root = join(dirname(cacheRoot), "initial-native");
  const frozen = await freezeLongMemEvalSemanticRun({ arm: "native_semantic", workspace_prefix: "bounded-native",
    source_cache_roots: [cacheRoot], source_publication_associations: [],
    correspondence_cache_root: join(dirname(cacheRoot), "correspondence"), discovery_page_cap: 4, correspondence_pair_cap: 1,
    authorized_scopes: { mode: "unrestricted" }, data_dir: dataDir, pinned_meta_root: pinnedMetaRoot,
    dataset_sha256: census.dataset_sha256, dataset_question_count: 1, question_ids: [question.question_id],
    model: MODEL, provider_url: STEP_PLAN_QUOTE_BASIS.selected_provider_url, request_profile: PROFILE,
    query_cache_root: join(dirname(cacheRoot), "query"), recorded_at: "2026-09-23T00:00:00.000Z",
    producer_commit: "a".repeat(40), max_output_tokens: 4096, output_byte_limit: 100000,
    budget: { schema_version: 1, work_units: 1000000, memory_bytes: 60000000,
      page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 } }, root);
  const prepared = await prepareLongMemEvalSemanticRun(root);
  const row = prepared.result.rows[0];
  if (row?.status !== "prepared") throw new Error(`native question preparation required: ${JSON.stringify(row)}`);
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(row.chain_root, "prepare.json")));
  const query = plan.queries[0];
  if (query === undefined || query.status === "blocked") throw new Error("native source opportunities required");
  const nativeIds = query.discovery_trace[0]!.access.source_candidates.slice(0, 10).map(source => source.source_id);
  const sourcePreflightPath = join(dirname(cacheRoot), "retained-source-preflight.json");
  const input = { root, preparedPath: prepared.path, sourcePreflightPath, sourceCacheRoot: cacheRoot };
  const direct = { plan, initialChainRoot: row.chain_root, population, sourcePreflightPath, sourceCacheRoot: cacheRoot,
    recordedAt: frozen.config.recorded_at, producerCommit: frozen.config.producer_commit };
  const preflight = async (ids: readonly string[] | undefined, selectedGeneration = generation()) => {
    const keys = ids?.map(id => {
      const source = census.records.find(candidate => candidate.source_id === id)!;
      const item = sourceSemanticArtifactPreparations(source.content_bytes, "complete-source", selectedGeneration)[0]!;
      if (item.status !== "ready") throw new Error("fixture ready source required");
      return prepareSourceSemanticRequestLine(item.semantic, [], { model: MODEL, requestProfile: PROFILE }).key;
    });
    const report = await preflightSourceSemanticInteractive({ variant: "longmemeval_s", cacheRoot, dataDir, pinnedMetaRoot,
      offset: 0, limit: 1, sourcePacking: "complete-source", openSemantics: selectedGeneration,
      ...(keys === undefined ? {} : { preflightKeys: [...new Set(keys)] }) });
    writeFileSync(sourcePreflightPath, JSON.stringify(report));
    return report;
  };
  return { census, nativeIds, input, direct, preflight, fetch };
}

it("binds a task-bearing prefix subset and preserves unowned, unassessed and the whole raw census through native final reopen", async () => {
  const fixture = await nativeQuestion();
  const preflight = await fixture.preflight(fixture.nativeIds.slice(0, 1));
  const input = { ...fixture.input, sourceRequestScope: { kind: "native_first_page" as const, source_cap: 3 } };
  const bound = await writeLongMemEvalLazyConfig(input, join(dirname(cacheRoot), "bounded-config.json"));
  expect(bound.dataset_sha256).toBe(fixture.census.dataset_sha256);
  expect(bound.config.chain.implementation_revision).toBe(readCurrentExtractionAuthorityRevision());
  expect(bound.config.source_request_selection).toEqual({ eligible_source_ids: fixture.nativeIds.slice(0, 3),
    unassessed_source_ids: fixture.census.records.filter(source => !fixture.nativeIds.slice(0, 3).includes(source.source_id))
      .map(source => source.source_id) });
  const request = parseSourceSemanticRequest(JSON.parse(preflight.ready_requests[0]!.userPrompt));
  expect(request.source_request.generation_task).toEqual(generation().generation_task);
  expect(request.source_request.original_source).toBe(fixture.census.records.find(source => source.source_id === fixture.nativeIds[0])!.content_bytes);
  const root = join(dirname(cacheRoot), "bounded-lazy");
  const window = await prepareLazyQualificationWindow(bound.config, root);
  expect(window.window.map(source => source.source_id)).toEqual(fixture.nativeIds);
  expect(window.window.map(source => source.state)).toEqual(["cache_miss", "unowned", "unowned", ...Array(7).fill("unassessed")]);
  expect(window.selected_missing_keys).toEqual(preflight.selected_keys);
  expect(window.config.chain.correspondence_pair_cap).toBe(1);
  const final = await sealLazyQualificationFinal(root);
  const publication = JSON.parse(readFileSync(final.publication_report_path, "utf8")) as {
    sources: { source_id: string; source_interpretation_generation_key?: string }[] };
  expect(publication.sources.map(source => source.source_id)).toEqual(fixture.census.records.map(source => source.source_id));
  expect(publication.sources.every(source => source.source_interpretation_generation_key === undefined)).toBe(true);
  const exposure = await replayLazyQualifiedFirstExposure(root);
  expect(exposure.result.provider_calls).toBe(0);
  expect(final.source_producer.new_authorized_attempts).toBe(0);
  expect(fixture.fetch).not.toHaveBeenCalled();
  const changed = { ...window, window: window.window.map((source, index) => index === 3
    ? { ...source, state: "cache_miss", key: preflight.selected_keys[0]!, cache_root: cacheRoot } : source) };
  unlinkSync(join(root, "window.json"));
  writeChainArtifact(join(root, "window.json"), changed);
  await expect(admitLazyWindow(root)).rejects.toThrow(/ownership|unassessed/u);
});

it("rejects requests outside the retained native first page and outside the explicit smaller cap", async () => {
  const fixture = await nativeQuestion();
  const outsider = fixture.census.records.find(source => !fixture.nativeIds.includes(source.source_id))!;
  await fixture.preflight([outsider.source_id]);
  await expect(admitNativeLazyConfig({ ...fixture.direct,
    sourceRequestScope: { kind: "native_first_page", source_cap: 10 } })).rejects.toThrow(/outside the native first-page source cap/u);
  await fixture.preflight(fixture.nativeIds.slice(1, 2));
  await expect(admitNativeLazyConfig({ ...fixture.direct,
    sourceRequestScope: { kind: "native_first_page", source_cap: 1 } })).rejects.toThrow(/outside the native first-page source cap/u);
});

it("keeps different query tasks in different request identities and refuses an incompatible task", async () => {
  const fixture = await nativeQuestion();
  const original = await fixture.preflight(fixture.nativeIds.slice(0, 1));
  const incompatible = await fixture.preflight(fixture.nativeIds.slice(0, 1), generation("What was started?"));
  expect(incompatible.selected_keys).not.toEqual(original.selected_keys);
  expect(incompatible.ready_requests[0]!.requestSha256).not.toBe(original.ready_requests[0]!.requestSha256);
  expect(incompatible.ready_requests[0]!.unitKeys).toEqual(original.ready_requests[0]!.unitKeys);
  await expect(admitNativeLazyConfig({ ...fixture.direct,
    sourceRequestScope: { kind: "native_first_page", source_cap: 1 } })).rejects.toThrow(/exact original query task/u);
});

it("rejects mutated complete original source text and changed occurrence assignments", async () => {
  const fixture = await nativeQuestion();
  const report = await fixture.preflight(fixture.nativeIds.slice(0, 1));
  const changed = JSON.parse(JSON.stringify(report));
  const body = JSON.parse(changed.ready_requests[0].userPrompt);
  body.source_request.original_source += " Unretained source text.";
  changed.ready_requests[0].userPrompt = JSON.stringify(body);
  writeFileSync(fixture.input.sourcePreflightPath, JSON.stringify(changed));
  const input = { ...fixture.direct, sourceRequestScope: { kind: "native_first_page" as const, source_cap: 1 } };
  await expect(admitNativeLazyConfig(input)).rejects.toThrow(/complete original source|malformed/u);
  const occurrence = { ...report,
    ready_requests: report.ready_requests.map(line => ({ ...line, unitKeys: ["foreign-occurrence"] })),
    planned_requests: report.planned_requests.map(line => ({ ...line, unitKeys: ["foreign-occurrence"] })) };
  parseSourceSemanticInteractivePreflight(occurrence);
  writeFileSync(fixture.input.sourcePreflightPath, JSON.stringify(occurrence));
  await expect(admitNativeLazyConfig(input)).rejects.toThrow(/occurrence assignments/u);
});

it("tracks zero-cap sources as unassessed and rejects a nonempty request owner under zero cap", async () => {
  const fixture = await nativeQuestion();
  const report = await fixture.preflight(fixture.nativeIds.slice(0, 1));
  const input = { ...fixture.input, sourceRequestScope: { kind: "native_first_page" as const, source_cap: 0 } };
  await expect(writeLongMemEvalLazyConfig(input, join(dirname(cacheRoot), "invalid-zero-config.json"))).rejects.toThrow(/outside/u);
  const empty = await fixture.preflight([]);
  expect(empty).toMatchObject({ execution_authorized: false, provider_calls: 0, selected_requests: 0,
    selected_keys: [], ready_requests: [], planned_requests: [], cost_bound_usd: 0 });
  expect(() => parseExtractionSampleKeys([])).toThrow();
  const bound = await writeLongMemEvalLazyConfig(input, join(dirname(cacheRoot), "zero-config.json"));
  expect(bound.config.source_request_selection?.eligible_source_ids).toEqual([]);
  expect(bound.config.source_request_selection?.unassessed_source_ids).toEqual(fixture.census.records.map(source => source.source_id));
  const root = join(dirname(cacheRoot), "zero-lazy");
  const window = await prepareLazyQualificationWindow(bound.config, root);
  expect(window.window).toHaveLength(10);
  expect(window.window.every(source => source.state === "unassessed" && source.key === null)).toBe(true);
  expect(window.selected_missing_keys).toEqual([]);
  const final = await sealLazyQualificationFinal(root);
  expect(final.selected_new_associations).toBe(0);
  expect(final.final_access?.observed_source_count).toBe(12);
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it("retains the complete-census compatibility owner and rejects its incomplete request set", async () => {
  const fixture = await nativeQuestion();
  const complete = await fixture.preflight(undefined, EXTRACTION_OPEN_SEMANTICS_GENERATION);
  const bound = await admitNativeLazyConfig(fixture.direct);
  expect(bound.sourceOwners.size).toBe(12);
  expect(bound.config.source_request_scope).toBeUndefined();
  const window = await prepareLazyQualificationWindow(bound.config, join(dirname(cacheRoot), "complete-lazy"));
  expect(window.selected_missing_keys).toHaveLength(10);
  expect(complete.ready_requests).toHaveLength(12);
  await fixture.preflight(fixture.nativeIds.slice(0, 1), EXTRACTION_OPEN_SEMANTICS_GENERATION);
  await expect(admitNativeLazyConfig(fixture.direct)).rejects.toThrow(/current ready source/u);
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it("rejects invalid negative, excessive and fractional per-question source caps", async () => {
  const fixture = await nativeQuestion();
  await fixture.preflight(fixture.nativeIds.slice(0, 1));
  for (const source_cap of [-1, 11, 0.5]) {
    await expect(admitNativeLazyConfig({ ...fixture.direct,
      sourceRequestScope: { kind: "native_first_page", source_cap } })).rejects.toThrow();
  }
});
