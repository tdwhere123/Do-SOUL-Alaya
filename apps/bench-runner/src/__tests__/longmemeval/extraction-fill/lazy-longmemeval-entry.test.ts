import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { prepareSourcePublicationAssociations } from "../../../runs/snapshot/source-records/prepare-associations.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { parseSourceSemanticInteractivePreflight, preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, prepareSourceSemanticRequestLine,
  sourceSemanticArtifactPreparations } from "../../../runs/extraction/request-artifact.js";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { prepareLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/execute.js";
import { runLongMemEvalSemanticLauncher } from "../../../runs/longmemeval-semantic/launch.js";
import { writeLongMemEvalLazyConfig } from "../../../runs/longmemeval-semantic/lazy-config.js";
import { writeDirectLazyConfig } from "../../../runs/semantic-chain/bind-lazy.js";
import { runSemanticChainLauncher } from "../../../runs/semantic-chain/launch.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { semanticProposalShardPath } from "../../../runs/semantic-proposal/artifact.js";
import { measureLongMemEvalLazyFirstExposure } from "../../../runs/longmemeval-semantic/lazy-measure.js";
import { prepareLazyQualificationWindow, sealLazyQualificationFinal,
  replayLazyQualifiedFirstExposure } from "../../../runs/semantic-chain/lazy-qualification.js";
import { chainIdentity, readChainArtifact, writeChainArtifact, writeChainJson } from "../../../runs/semantic-chain/contract.js";
import { inspectSemanticChainReplayTarget } from "../../../runs/semantic-chain/replay.js";
import type { LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";

const MODEL = "step-3.5-flash-2603";
const PROFILE = "step-3.5-2603-low-json-schema-v1" as const;
const BUDGET = { schema_version: 1 as const, work_units: 1_000_000, memory_bytes: 60_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks(roots => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), "longmemeval_s");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function question(id: string, count: number, answerSessionId = `${id}-session-0`): LongMemEvalQuestion {
  return { question_id: id, question_type: "single_session", question: `What did ${id} complete?`,
    answer: "fixture only", question_date: "2026-09-23",
    haystack_session_ids: Array.from({ length: count }, (_, index) => `${id}-session-${index}`),
    haystack_dates: Array.from({ length: count }, () => "2023-09-10"),
    haystack_sessions: Array.from({ length: count }, (_, index) => [
      { role: "user", content: `I completed item ${index} for ${id}.`, has_answer: index === 0 }]),
    answer_session_ids: [answerSessionId] };
}

async function preparedQuestion(id: string, index: number, questionCount: number,
  queryTransport: { model: string; profile: string; providerUrl: string } = { model: MODEL, profile: PROFILE,
    providerUrl: STEP_PLAN_QUOTE_BASIS.selected_provider_url }, budget = BUDGET) {
  const census = await censusCompleteSourceRecords({ population: "longmemeval_s", dataDir, pinnedMetaRoot });
  const root = join(dirname(cacheRoot), `initial-${id}`);
  const frozen = await freezeLongMemEvalSemanticRun({ arm: "native_semantic",
    workspace_prefix: `lazy-${id}`, source_cache_roots: [cacheRoot], source_publication_associations: [],
    correspondence_cache_root: join(dirname(cacheRoot), `correspondence-${id}`),
    discovery_page_cap: 4, correspondence_pair_cap: 2, authorized_scopes: { mode: "named", scopes: ["project"] },
    data_dir: dataDir, pinned_meta_root: pinnedMetaRoot, dataset_sha256: census.dataset_sha256,
    dataset_question_count: questionCount, question_ids: [id],
    model: queryTransport.model, provider_url: queryTransport.providerUrl, request_profile: queryTransport.profile,
    query_cache_root: join(dirname(cacheRoot), `query-${id}`),
    recorded_at: "2026-09-23T00:00:00.000Z", producer_commit: "a".repeat(40),
    max_output_tokens: 4096, output_byte_limit: 100000,
    budget }, root);
  expect(frozen.selected).toHaveLength(1);
  const preflight = await preflightSourceSemanticInteractive({ variant: "longmemeval_s", cacheRoot,
    dataDir, pinnedMetaRoot, offset: index, limit: 1, sourcePacking: "complete-source",
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION });
  const sourcePreflightPath = join(dirname(cacheRoot), `full-source-${id}.json`);
  writeFileSync(sourcePreflightPath, JSON.stringify(preflight));
  const prepared = await prepareLongMemEvalSemanticRun(root);
  const input = { root, preparedPath: prepared.path, sourcePreflightPath, sourceCacheRoot: cacheRoot };
  return { frozen, preflight, prepared, input };
}

it("binds a direct authored query to its sealed source container and rejects changed owners", async () => {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  const guardedFetch = vi.fn(async () => { throw new Error("provider must not be called"); });
  vi.stubGlobal("fetch", guardedFetch);
  await writeDataset([question("container", 12)]);
  const source = await preparedQuestion("container", 0, 1);
  const row = source.prepared.result.rows[0];
  if (row?.status !== "prepared") throw new Error("source container did not prepare");
  const container = readChainArtifact(join(row.chain_root, "prepare.json")) as { config: Record<string, unknown> };
  const authoredQuestion = "Which item was completed in the source container?";
  const chainConfig = { ...container.config,
    query_workset: { ...source.frozen.query_workset, items: [{ original_query: authoredQuestion }] },
    query_cache_root: join(dirname(cacheRoot), "authored-query-cache") };
  const chainRoot = join(dirname(cacheRoot), "authored-initial-chain");
  const plan = await prepareSemanticChain(chainConfig, chainRoot);
  expect(plan.queries).toMatchObject([{ status: "raw_ready", original_query: authoredQuestion, reason: "unattempted" }]);
  expect(plan.queries[0]?.query_key).not.toBe(source.frozen.selected[0]?.query_key);
  const population = { name: "longmemeval_s", dataDir, pinnedMetaRoot,
    questionWindow: { offset: 0, limit: 1 } };
  const input = { root: chainRoot, chainConfig, population,
    sourcePreflightPath: source.input.sourcePreflightPath, sourceCacheRoot: cacheRoot,
    recordedAt: source.frozen.config.recorded_at, producerCommit: source.frozen.config.producer_commit };
  const configPath = join(dirname(cacheRoot), "authored-lazy.json");
  const bound = await writeDirectLazyConfig(input, configPath);
  expect(bound.config.chain.query_workset.items).toEqual([{ original_query: authoredQuestion }]);
  expect(bound.config.initial_query_state_identity).toMatch(/^[a-f0-9]{64}$/u);
  expect(bound.config.source_preparation).toMatchObject({ output_token_cap: 4096,
    retained_preflight_identity: chainIdentity(source.preflight) });
  expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(bound.config);
  const chainPath = join(dirname(cacheRoot), "authored-chain.json");
  const populationPath = join(dirname(cacheRoot), "authored-population.json");
  writeChainJson(chainPath, chainConfig);
  writeChainJson(populationPath, population);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await runSemanticChainLauncher(["bind-lazy", "--root", chainRoot,
    "--config", chainPath, "--population", populationPath,
    "--source-preflight", source.input.sourcePreflightPath, "--source-cache-root", cacheRoot,
    "--recorded-at", input.recordedAt, "--producer-commit", input.producerCommit,
    "--out", configPath])).toBe(0);
  expect(stdout).toHaveBeenCalled();
  const window = await prepareLazyQualificationWindow(bound.config, join(dirname(cacheRoot), "authored-lazy-root"));
  expect(window.query_key).toBe(plan.queries[0]?.query_key);
  expect(window.window).toHaveLength(10);
  expect(guardedFetch).not.toHaveBeenCalled();
  await expect(prepareLazyQualificationWindow({ ...bound.config,
    initial_query_state_identity: undefined }, join(dirname(cacheRoot), "unbound-query"))).rejects.toThrow();
  await expect(prepareLazyQualificationWindow({ ...bound.config,
    source_preparation: undefined }, join(dirname(cacheRoot), "unbound-source"))).rejects.toThrow();

  await expect(writeDirectLazyConfig({ ...input, chainConfig: { ...chainConfig, run_id: "other" } },
    join(dirname(cacheRoot), "changed-config.json"))).rejects.toThrow(/differs from its native preparation/u);
  await expect(writeDirectLazyConfig({ ...input, sourcePreflightPath: join(dirname(cacheRoot), "missing-preflight.json") },
    join(dirname(cacheRoot), "missing-owner.json"))).rejects.toThrow();
  const original = readFileSync(input.sourcePreflightPath, "utf8");
  const foreign = JSON.parse(original);
  foreign.ready_requests[0].unitKeys = ["foreign-occurrence"];
  const foreignPath = join(dirname(cacheRoot), "foreign-preflight.json");
  writeFileSync(foreignPath, JSON.stringify(foreign));
  await expect(writeDirectLazyConfig({ ...input, sourcePreflightPath: foreignPath },
    join(dirname(cacheRoot), "foreign-owner.json"))).rejects.toThrow(/foreign ready key/u);
  const incomplete = JSON.parse(original);
  incomplete.ready_requests.pop();
  const incompletePath = join(dirname(cacheRoot), "incomplete-preflight.json");
  writeFileSync(incompletePath, JSON.stringify(incomplete));
  await expect(writeDirectLazyConfig({ ...input, sourcePreflightPath: incompletePath },
    join(dirname(cacheRoot), "incomplete-owner.json"))).rejects.toThrow();
  const shard = semanticProposalShardPath(chainConfig.query_cache_root as string, plan.queries[0]!.query_key);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, "invalid query cache");
  await expect(writeDirectLazyConfig(input, join(dirname(cacheRoot), "changed-query.json")))
    .rejects.toThrow(/query-semantics state changed/u);
});

it("binds one original question through full-source preflight, native window, final SQLite and first exposure before isolated scoring", async () => {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  const guardedFetch = vi.fn(async () => { throw new Error("provider must not be called"); });
  vi.stubGlobal("fetch", guardedFetch);
  await writeDataset([question("alpha", 12), question("beta", 2)]);
  const alpha = await preparedQuestion("alpha", 0, 2);
  const ownerBytes = readFileSync(alpha.input.sourcePreflightPath);
  const foreignOwner = JSON.parse(ownerBytes.toString("utf8"));
  foreignOwner.planned_requests[0].unitKeys = ["foreign-occurrence"];
  writeFileSync(alpha.input.sourcePreflightPath, JSON.stringify(foreignOwner));
  await expect(writeLongMemEvalLazyConfig(alpha.input, join(dirname(cacheRoot), "foreign-owner.json")))
    .rejects.toThrow(/foreign ready key/u);
  foreignOwner.planned_requests[0].unitKeys = alpha.preflight.planned_requests[0]!.unitKeys;
  foreignOwner.ready_requests[0].unitKeys = ["foreign-occurrence"];
  writeFileSync(alpha.input.sourcePreflightPath, JSON.stringify(foreignOwner));
  await expect(writeLongMemEvalLazyConfig(alpha.input, join(dirname(cacheRoot), "foreign-ready-owner.json")))
    .rejects.toThrow(/foreign ready key/u);
  writeFileSync(alpha.input.sourcePreflightPath, ownerBytes);
  const configPath = join(dirname(cacheRoot), "lazy-config-alpha.json");
  const bound = await writeLongMemEvalLazyConfig(alpha.input, configPath);
  expect(bound).toMatchObject({ question_id: "alpha", question_index: 0, source_output_token_cap: 4096 });
  expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(bound.config);
  expect((await writeLongMemEvalLazyConfig(alpha.input, configPath)).config).toEqual(bound.config);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await runLongMemEvalSemanticLauncher(["bind-lazy", "--root", alpha.input.root,
    "--prepared", alpha.input.preparedPath, "--source-preflight", alpha.input.sourcePreflightPath,
    "--source-cache-root", alpha.input.sourceCacheRoot, "--out", configPath])).toBe(0);
  expect(stdout).toHaveBeenCalled();
  const lazyRoot = join(dirname(cacheRoot), "lazy-alpha");
  await expect(prepareLazyQualificationWindow({ ...bound.config,
    initial_query_state_identity: "f".repeat(64) }, join(dirname(cacheRoot), "wrong-query-state")))
    .rejects.toThrow(/native binding/u);
  await expect(prepareLazyQualificationWindow({ ...bound.config,
    source_preparation: { ...bound.config.source_preparation!, output_token_cap: 4095 } },
  join(dirname(cacheRoot), "wrong-source-cap"))).rejects.toThrow(/native binding/u);
  const window = await prepareLazyQualificationWindow(bound.config, lazyRoot);
  expect(window.window).toHaveLength(10);
  expect(window.window.map(row => row.record_id)).toEqual(window.starting_access.source_candidates.slice(0, 10).map(row => row.record_id));
  expect(window.selected_missing_keys).toHaveLength(10);
  const final = await sealLazyQualificationFinal(lazyRoot);
  const finalReport = JSON.parse(readFileSync(final.publication_report_path, "utf8"));
  expect(finalReport).toMatchObject({ census_count: 12, admitted_count: 12, published_count: 0 });
  expect(final.final_snapshot_path).not.toBe(bound.config.chain.snapshot_path);
  const notYet = await measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot,
    evaluatorRoot: join(dirname(cacheRoot), "too-early-evaluator") });
  expect(notYet.result).toMatchObject({ primary: { eligible: 1, hits: 0, misses: 0, unknown: 1 },
    first_exposure_identity: null, replay_identity: null });
  expect(notYet.result.rows.find(row => row.question_id === "alpha")).toMatchObject({
    outcome: "unknown", reason: "first_exposure_not_durable", measurement_path: null });
  expect(readChainArtifact(notYet.path)).toEqual(notYet.result);
  const target = inspectSemanticChainReplayTarget(final.final_chain_root, "retained");
  const reservationPath = join(lazyRoot, "first-exposure.reserved.json");
  const wrongReservation = { final_identity: "f".repeat(64), replay_identity: target.identity,
    replay_path: target.output };
  writeFileSync(reservationPath, JSON.stringify({ identity: chainIdentity(wrongReservation), payload: wrongReservation }));
  await expect(measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot,
    evaluatorRoot: join(dirname(cacheRoot), "too-early-evaluator") }))
    .rejects.toThrow(/reserved first exposure differs/u);
  const correctReservation = { ...wrongReservation, final_identity: chainIdentity(final) };
  writeFileSync(reservationPath, JSON.stringify({ identity: chainIdentity(correctReservation), payload: correctReservation }));
  const nativeRowPath = target.rowPaths.get(window.query_key)!;
  writeChainArtifact(`${nativeRowPath}.reserved`, { replay_identity: target.identity, query_key: window.query_key });
  const unknownExposure = await measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot,
    evaluatorRoot: join(dirname(cacheRoot), "too-early-evaluator") });
  expect(unknownExposure.result).toMatchObject({ primary: { eligible: 1, hits: 0, misses: 0, unknown: 1 },
    first_exposure_identity: null });
  expect(unknownExposure.result.rows.find(row => row.question_id === "alpha")).toMatchObject({
    reason: "first_exposure_reserved_unknown", measurement_path: null });
  unlinkSync(reservationPath);
  const orphanNativeReservation = await measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot,
    evaluatorRoot: join(dirname(cacheRoot), "too-early-evaluator") });
  expect(orphanNativeReservation.result.rows.find(row => row.question_id === "alpha")?.reason)
    .toBe("first_exposure_reserved_unknown");
  writeChainArtifact(reservationPath, correctReservation);
  unlinkSync(`${nativeRowPath}.reserved`);
  const first = await replayLazyQualifiedFirstExposure(lazyRoot);
  expect(first.result).toMatchObject({ provider_calls: 0, arm: "retained" });
  expect(first.result.rows).toHaveLength(1);
  expect(await replayLazyQualifiedFirstExposure(lazyRoot)).toEqual(first);
  const evaluatorRoot = join(dirname(cacheRoot), "evaluator-alpha");
  const measured = await measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot, evaluatorRoot });
  expect(measured.result).toMatchObject({ contract: "longmemeval-lazy-semantic-measurement-v1",
    status: "development_only", provider_calls: 0, question_id: "alpha",
    inventory: { questions: 2, answerable: 2, abstention: 0 }, primary: { eligible: 1 } });
  expect(measured.result.primary.hits + measured.result.primary.misses + measured.result.primary.unknown).toBe(1);
  expect(measured.result.rows.find(row => row.question_id === "beta")?.outcome).toBe("not_selected_development");
  expect(measured.path.startsWith(evaluatorRoot)).toBe(true);
  expect(readChainArtifact(measured.path)).toEqual(measured.result);
  expect(await measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot, evaluatorRoot })).toEqual(measured);
  const physicalQueryBucket = join(dirname(cacheRoot), "physical-lazy-query-bucket");
  const queryBucket = join(alpha.frozen.config.query_cache_root, alpha.frozen.selected[0]!.query_key.slice(0, 2));
  mkdirSync(physicalQueryBucket);
  mkdirSync(alpha.frozen.config.query_cache_root, { recursive: true });
  symlinkSync(physicalQueryBucket, queryBucket, "dir");
  await expect(measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot, evaluatorRoot: physicalQueryBucket }))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(readdirSync(physicalQueryBucket)).toEqual([]);
  unlinkSync(queryBucket);
  expect(await runLongMemEvalSemanticLauncher(["measure-lazy", "--root", alpha.input.root,
    "--prepared", alpha.input.preparedPath, "--source-preflight", alpha.input.sourcePreflightPath,
    "--source-cache-root", alpha.input.sourceCacheRoot, "--lazy-root", lazyRoot,
    "--evaluator-root", evaluatorRoot])).toBe(0);
  await expect(measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot,
    evaluatorRoot: join(lazyRoot, "gold-in-producer") })).rejects.toThrow(/separate from producer/u);
  const symlinked = join(dirname(cacheRoot), "linked-producer");
  symlinkSync(lazyRoot, symlinked, "dir");
  await expect(measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot,
    evaluatorRoot: join(symlinked, "not-yet-created") })).rejects.toThrow(/separate from producer/u);
  expect(existsSync(join(lazyRoot, "not-yet-created"))).toBe(false);
  const metadataAlias = join(dirname(cacheRoot), "linked-metadata");
  symlinkSync(pinnedMetaRoot, metadataAlias, "dir");
  for (const unsafe of [dataDir, pinnedMetaRoot, join(metadataAlias, "nested-output")]) {
    await expect(measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot, evaluatorRoot: unsafe }))
      .rejects.toThrow(/separate from producer and input roots/u);
  }
  const physicalMeta = join(dirname(cacheRoot), "physical-metadata-file");
  mkdirSync(physicalMeta);
  const metadataPath = join(pinnedMetaRoot, "longmemeval_s.meta.json");
  const physicalMetadataPath = join(physicalMeta, "pin.json");
  renameSync(metadataPath, physicalMetadataPath);
  symlinkSync(physicalMetadataPath, metadataPath);
  await expect(measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot, evaluatorRoot: physicalMeta }))
    .rejects.toThrow(/separate from producer and input roots/u);
  const physicalRows = join(dirname(cacheRoot), "physical-replay-rows");
  const replayRows = join(final.final_chain_root, `replay-${target.identity}`);
  renameSync(replayRows, physicalRows);
  symlinkSync(physicalRows, replayRows, "dir");
  await expect(measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot, evaluatorRoot: physicalRows }))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(readdirSync(physicalRows).some(name => name.startsWith("measurement-"))).toBe(false);
  const initial = alpha.prepared.result.rows[0];
  if (initial?.status !== "prepared") throw new Error("initial chain required");
  const physicalInitial = join(dirname(cacheRoot), "physical-initial-chain");
  renameSync(initial.chain_root, physicalInitial);
  symlinkSync(physicalInitial, initial.chain_root, "dir");
  await expect(measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot, evaluatorRoot: physicalInitial }))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(readdirSync(physicalInitial).some(name => name.startsWith("measurement-") || name.startsWith("lazy-measurement-"))).toBe(false);
  unlinkSync(initial.chain_root);
  renameSync(physicalInitial, initial.chain_root);
  expect(readdirSync(dataDir).some(name => name.startsWith("measurement-") || name.startsWith("lazy-measurement-"))).toBe(false);
  expect(readdirSync(pinnedMetaRoot).some(name => name.startsWith("measurement-") || name.startsWith("lazy-measurement-"))).toBe(false);
  expect(existsSync(join(pinnedMetaRoot, "nested-output"))).toBe(false);
  expect(guardedFetch).not.toHaveBeenCalled();

  const beta = await preparedQuestion("beta", 1, 2);
  await expect(measureLongMemEvalLazyFirstExposure({ ...beta.input, lazyRoot,
    evaluatorRoot: join(dirname(cacheRoot), "evaluator-beta") })).rejects.toThrow(/another frozen LongMemEval question/u);
  const reportBytes = readFileSync(final.publication_report_path);
  const corruptedReport = { ...finalReport, census_count: 11 };
  writeFileSync(final.publication_report_path, JSON.stringify(corruptedReport));
  await expect(measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot, evaluatorRoot }))
    .rejects.toThrow(/final publication|source census/u);
  writeFileSync(final.publication_report_path, reportBytes);
  const firstPath = join(lazyRoot, "first-exposure.json");
  const firstBytes = readFileSync(firstPath);
  const forged = { ...readChainArtifact(firstPath) as object, replay_path: join(lazyRoot, "foreign-replay.json") };
  writeFileSync(firstPath, JSON.stringify({ identity: chainIdentity(forged), payload: forged }));
  await expect(measureLongMemEvalLazyFirstExposure({ ...alpha.input, lazyRoot, evaluatorRoot }))
    .rejects.toThrow(/first exposure|replay/u);
  writeFileSync(firstPath, firstBytes);
  expect(guardedFetch).not.toHaveBeenCalled();
}, 120000);

it("scores an observed answer-session source as a confirmed native first-exposure hit", async () => {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  const guardedFetch = vi.fn(async () => { throw new Error("provider must not be called"); });
  vi.stubGlobal("fetch", guardedFetch);
  const row = question("direct", 1);
  row.answer_session_ids.push("unmapped-answer-session");
  await writeDataset([row]);
  const prepared = await preparedQuestion("direct", 0, 1);
  const bound = await writeLongMemEvalLazyConfig(prepared.input, join(dirname(cacheRoot), "direct-config.json"));
  const lazyRoot = join(dirname(cacheRoot), "lazy-direct");
  const window = await prepareLazyQualificationWindow(bound.config, lazyRoot);
  expect(window.window).toHaveLength(1);
  await sealLazyQualificationFinal(lazyRoot);
  const first = await replayLazyQualifiedFirstExposure(lazyRoot);
  expect(first.delivery.selected_delivered).toBe(1);
  const measured = await measureLongMemEvalLazyFirstExposure({ ...prepared.input, lazyRoot,
    evaluatorRoot: join(dirname(cacheRoot), "evaluator-direct") });
  expect(measured.result.primary).toMatchObject({ eligible: 1, hits: 1, misses: 0, unknown: 0 });
  expect(guardedFetch).not.toHaveBeenCalled();
}, 120000);

it("binds a fresh question to one previously received compatible source without selecting a new request", async () => {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  const first = question("cold", 1), second = question("warm", 1);
  first.haystack_sessions[0]![0]!.content = "I completed alpha.";
  second.haystack_sessions[0]![0]!.content = "I completed alpha.";
  await writeDataset([first, second]);
  const coldOptions = { variant: "longmemeval_s" as const, cacheRoot, dataDir, pinnedMetaRoot,
    offset: 0, limit: 1, sourcePacking: "complete-source" as const,
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, concurrency: 1, log: () => undefined };
  const inspection = await inspectExtractionAuthority({ ...coldOptions, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  expect(inspection.missingKeys).toHaveLength(1);
  const preflight = await preflightSourceSemanticInteractive({ ...coldOptions,
    preflightKeys: inspection.missingKeys });
  const scope = createExtractionSampleScope(inspection.missingKeys, inspection);
  const receipt = createExtractionAuthorityReceipt({ action: "sample", sampleScope: scope,
    observation: inspection.observation, inspection, maxConcurrency: 1, sourcePreflight: preflight,
    outputTokenCap: { field: "max_tokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
      outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const authorityReceiptPath = join(cacheRoot, "authored-cold-authority.json");
  writeExtractionAuthorityReceipt(authorityReceiptPath, receipt);
  const authoredFetch = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const request = parseSourceSemanticRequest(JSON.parse(wire.messages[1]!.content));
    const assertion = request.source_request.source_assertions[0]!;
    const raw = JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
      content: { roots: [{ act: "assertion", expression: { kind: "content_ref", key: "complete" } }],
        entities: [{ form: "selection", key: "theme", selection: { assertion_id: assertion.assertion_id, text: "alpha" } }],
        nodes: [{ kind: "statement", key: "complete",
          predicate: { kind: "explicit", reading: "complete", support: { assertion_id: assertion.assertion_id, text: "completed" } },
          arguments: [{ role: "theme", target: { kind: "entity_ref", key: "theme" } }], qualifications: [] }], gaps: [] } });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: raw }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", authoredFetch);
  await runExtractionFill({ ...coldOptions, authorityReceiptPath });
  expect(authoredFetch).toHaveBeenCalledTimes(1);
  const noProvider = vi.fn(async () => { throw new Error("warm bridge must not dispatch"); });
  vi.stubGlobal("fetch", noProvider);
  const warm = await preparedQuestion("warm", 1, 2);
  expect(warm.preflight).toMatchObject({ total_requests: 1, selected_requests: 0,
    cached_requests: 1, ready_requests: [{ key: preflight.ready_requests[0]!.key }] });
  expect(warm.preflight.ready_requests[0]!.unitKeys).not.toEqual(preflight.ready_requests[0]!.unitKeys);
  const warmBytes = readFileSync(warm.input.sourcePreflightPath);
  writeFileSync(warm.input.sourcePreflightPath, JSON.stringify({ ...warm.preflight,
    ready_requests: [{ ...warm.preflight.ready_requests[0], unitKeys: ["foreign-occurrence"] }] }));
  await expect(writeLongMemEvalLazyConfig(warm.input, join(dirname(cacheRoot), "wrong-warm-owner.json")))
    .rejects.toThrow(/source occurrence assignments/u);
  writeFileSync(warm.input.sourcePreflightPath, warmBytes);
  const associations = await prepareSourcePublicationAssociations({ name: "longmemeval_s", dataDir,
    pinnedMetaRoot, model: MODEL, requestProfile: PROFILE, questionWindow: { offset: 1, limit: 1 },
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION }, [{ cacheRoot,
    retainedPreparationPath: warm.input.sourcePreflightPath }], join(dirname(cacheRoot), "warm-associations.json"));
  expect(associations).toMatchObject({ ready_request_keys: 1,
    retained_preparations: [{ selected_request_keys: 0 }] });
  expect(associations.publicationAssociations).toHaveLength(1);
  const bound = await writeLongMemEvalLazyConfig(warm.input, join(dirname(cacheRoot), "warm-bound.json"));
  const lazyRoot = join(dirname(cacheRoot), "lazy-warm");
  const window = await prepareLazyQualificationWindow(bound.config, lazyRoot);
  expect(window.selected_missing_keys).toEqual([]);
  expect(window.window).toMatchObject([{ state: "cache_hit_interpreted" }]);
  await sealLazyQualificationFinal(lazyRoot);
  const firstExposure = await replayLazyQualifiedFirstExposure(lazyRoot);
  expect(firstExposure.result.rows).toHaveLength(1);
  expect(noProvider).not.toHaveBeenCalled();
}, 120000);

it("keeps a zero-assertion host request separate from payable and cached ready requests", async () => {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  await writeDataset([question("zero-host", 2)]);
  const options = { variant: "longmemeval_s" as const, cacheRoot, dataDir, pinnedMetaRoot,
    offset: 0, limit: 1, sourcePacking: "complete-source" as const,
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const full = await preflightSourceSemanticInteractive(options);
  expect(full).toMatchObject({ total_requests: 2, selected_requests: 2, deterministic_requests: 0 });
  const selected = await preflightSourceSemanticInteractive({ ...options,
    preflightKeys: [full.ready_requests[0]!.key] });
  const empty = sourceSemanticArtifactPreparations("", "complete-source", EXTRACTION_OPEN_SEMANTICS_GENERATION)[0]!;
  if (empty.status !== "ready") throw new Error("host empty source fixture must be ready");
  const zeroLine = prepareSourceSemanticRequestLine(empty.semantic, [], selected.config);
  const report = parseSourceSemanticInteractivePreflight({ ...selected,
    selected_keys: [selected.selected_keys[0]!, zeroLine.key].sort(),
    ready_requests: [...selected.ready_requests, zeroLine].sort((left, right) => left.key.localeCompare(right.key)),
    deterministic_requests: 1 });
  expect(report).toMatchObject({ selected_requests: 1, cached_requests: 0,
    deterministic_requests: 1, ready_requests: [{}, {}] });
  expect(() => parseSourceSemanticInteractivePreflight({ ...report, deterministic_requests: 0 }))
    .toThrow(/population or selected keys|deterministic source count/u);
}, 120000);

it("keeps abstention outside the answerable denominator after a durable native first exposure", async () => {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  const guardedFetch = vi.fn(async () => { throw new Error("provider must not be called"); });
  vi.stubGlobal("fetch", guardedFetch);
  await writeDataset([question("abstain_abs", 1)]);
  const prepared = await preparedQuestion("abstain_abs", 0, 1, {
    model: "gemini-2.5-flash-lite", profile: "gemini-2.5-nonthinking-v1",
    providerUrl: "https://fixture-gemini.invalid" });
  const bound = await writeLongMemEvalLazyConfig(prepared.input, join(dirname(cacheRoot), "abstention-config.json"));
  expect(bound.config.chain.query_workset.request_profile).toBe("gemini-2.5-nonthinking-v1");
  expect(bound.config.source_population.requestProfile).toBe(PROFILE);
  const lazyRoot = join(dirname(cacheRoot), "lazy-abstention");
  await prepareLazyQualificationWindow(bound.config, lazyRoot);
  await sealLazyQualificationFinal(lazyRoot);
  await replayLazyQualifiedFirstExposure(lazyRoot);
  const measured = await measureLongMemEvalLazyFirstExposure({ ...prepared.input, lazyRoot,
    evaluatorRoot: join(dirname(cacheRoot), "evaluator-abstention") });
  expect(measured.result.primary).toEqual({ eligible: 0, hits: 0, misses: 0, unknown: 0,
    lower_bound: null, upper_bound: null });
  expect(measured.result.rows[0]).toMatchObject({ cohort: "abstention", outcome: "uncalibrated" });
  expect(guardedFetch).not.toHaveBeenCalled();
}, 120000);

it("retains unsupported source rows and an incomplete gold join as unknown without calling a provider", async () => {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  const guardedFetch = vi.fn(async () => { throw new Error("provider must not be called"); });
  vi.stubGlobal("fetch", guardedFetch);
  const unsupported = `I completed item 0. ${Array.from({ length: 128 }, (_, index) => `Part ${index} occurred.`).join(" ")}`;
  const row = question("partial", 2, "missing-answer-session");
  row.haystack_sessions[0]![0]!.content = unsupported;
  await writeDataset([row]);
  const prepared = await preparedQuestion("partial", 0, 1);
  expect(prepared.preflight).toMatchObject({ source_occurrences: 2, unsupported_source_occurrences: 1 });
  const bound = await writeLongMemEvalLazyConfig(prepared.input, join(dirname(cacheRoot), "lazy-config-partial.json"));
  const lazyRoot = join(dirname(cacheRoot), "lazy-partial");
  const window = await prepareLazyQualificationWindow(bound.config, lazyRoot);
  expect(window.window.some(source => source.state === "unsupported_source")).toBe(true);
  const final = await sealLazyQualificationFinal(lazyRoot);
  const report = JSON.parse(readFileSync(final.publication_report_path, "utf8"));
  expect(report).toMatchObject({ census_count: 2, admitted_count: 2,
    host_preparation_counts: { unsupported_source: 1 } });
  await replayLazyQualifiedFirstExposure(lazyRoot);
  const measured = await measureLongMemEvalLazyFirstExposure({ ...prepared.input, lazyRoot,
    evaluatorRoot: join(dirname(cacheRoot), "evaluator-partial") });
  expect(measured.result).toMatchObject({ primary: { eligible: 1, hits: 0, misses: 0, unknown: 1 } });
  expect(measured.result.rows.find(source => source.selected)?.reason).toBe("source_or_gold_mapping_incomplete");
  expect(guardedFetch).not.toHaveBeenCalled();
}, 120000);

it("keeps a bounded open window and withholds a negative answer from an unvisited source", async () => {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  const guardedFetch = vi.fn(async () => { throw new Error("provider must not be called"); });
  vi.stubGlobal("fetch", guardedFetch);
  const row = question("budgeted", 12, "budgeted-session-11");
  row.haystack_sessions[0]![0]!.content = "I completed alpha. ".repeat(5000);
  await writeDataset([row]);
  const prepared = await preparedQuestion("budgeted", 0, 1, undefined,
    { ...BUDGET, work_units: 50_000, memory_bytes: 2_000_000,
      page_budget: 20_000, finalization_reserve: 1_000 });
  const bound = await writeLongMemEvalLazyConfig(prepared.input, join(dirname(cacheRoot), "budgeted-config.json"));
  const lazyRoot = join(dirname(cacheRoot), "lazy-budgeted");
  const window = await prepareLazyQualificationWindow(bound.config, lazyRoot);
  expect(window.window.length).toBeLessThanOrEqual(10);
  expect(window.window_open).toBe(true);
  const final = await sealLazyQualificationFinal(lazyRoot);
  const report = JSON.parse(readFileSync(final.publication_report_path, "utf8"));
  expect(report).toMatchObject({ census_count: 12, admitted_count: 12 });
  await replayLazyQualifiedFirstExposure(lazyRoot);
  const measured = await measureLongMemEvalLazyFirstExposure({ ...prepared.input, lazyRoot,
    evaluatorRoot: join(dirname(cacheRoot), "evaluator-budgeted") });
  expect(measured.result.primary).toMatchObject({ eligible: 1, hits: 0, misses: 0, unknown: 1 });
  expect(guardedFetch).not.toHaveBeenCalled();
}, 120000);
