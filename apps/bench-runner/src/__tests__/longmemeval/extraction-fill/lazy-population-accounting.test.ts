import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isContainedPath } from "../../../runs/fs/opened-contained-path.js";
import { afterEach, expect, it, vi } from "vitest";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import type { LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";
import { registerExtractionFillHooks } from "./fixture.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { measureLongMemEvalLazyFirstExposure } from "../../../runs/longmemeval-semantic/lazy-measure.js";
import { summarizeLongMemEvalOutcomes } from "../../../runs/longmemeval-semantic/measure.js";
import { inspectPopulationAttemptScopes } from "../../../runs/longmemeval-semantic/population-attempts.js";
import { forkSettledExtractionAttemptLedger, openExtractionAttemptLedger } from
  "../../../runs/extraction/authority/attempt-ledger.js";
import { chainIdentity, readChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { freezeLongMemEvalLazyPopulation,
  readLongMemEvalLazyPopulation, runLongMemEvalLazyPopulationStage } from
  "../../../runs/longmemeval-semantic/population.js";
import { observeLongMemEvalLazyPopulation } from
  "../../../runs/longmemeval-semantic/population-observation.js";
import { runLongMemEvalSemanticLauncher } from "../../../runs/longmemeval-semantic/launch.js";

const roots: string[] = [];
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks(roots => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), "longmemeval_s");
afterEach(async () => {
  vi.unstubAllGlobals();
  await settleActiveBenchDaemonTasks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const digest = "a".repeat(64);

function authoredPopulation(kind: "development20" | "reused_readiness50") {
  const base = mkdtempSync(join(tmpdir(), "lazy-population-")); roots.push(base);
  const root = join(base, "population");
  const development20 = Array.from({ length: 20 }, (_, index) => ({ question_id: `development-${index}`, index }));
  const reused50 = Array.from({ length: 50 }, (_, offset) => ({ question_id: `reused-${offset}`,
    index: offset + 20, cohort: "answerable" as const }));
  const metadata = { development20, reused50, provenance: { dataset: { variant: "longmemeval_s",
    sha256: digest, inventory_count: 500, answerable_count: 470, abstention_count: 30 } },
    flags: { preparation_only: true, executable_freeze: false, provider_calls: 0, benchmark_runs: 0 } };
  const membership_index_path = join(base, "membership.json");
  writeFileSync(membership_index_path, JSON.stringify(metadata));
  const selected = kind === "development20" ? development20 : reused50;
  const members = selected.map((entry, position) => ({ question_id: entry.question_id, index: entry.index,
    dataset_cohort: "answerable" as const,
    native_root: join(base, "native", String(position)), lazy_root: join(base, "lazy", String(position)),
    evaluator_root: join(base, "gold", String(position)),
    native_config_path: join(base, "configs", `${position}.json`),
    source_preflight_path: join(base, "preflight", `${position}.json`),
    source_cache_root: join(base, "cache", `${position}`),
    lazy_config_path: join(base, "bound", `${position}.json`),
    resource_reference: `authored-resource-${position}`, dispatch_reference: null,
    execution_policy: "held" as const, prior_development_exposure: true }));
  mkdirSync(join(base, "configs"), { recursive: true });
  for (const member of members) writeFileSync(member.native_config_path, JSON.stringify({
    arm: "native_semantic", workspace_prefix: `authored-${member.index}`,
    source_cache_roots: [member.source_cache_root], source_publication_associations: [],
    correspondence_cache_root: join(base, "correspondence", String(member.index)),
    discovery_page_cap: 4, correspondence_pair_cap: 2,
    authorized_scopes: { mode: "named", scopes: ["project"] },
    data_dir: join(base, "data"), pinned_meta_root: join(base, "pinned"), dataset_sha256: digest,
    dataset_question_count: 500, question_ids: [member.question_id], stage: "development",
    previously_exposed_question_ids: [member.question_id],
    model: "step-3.5-flash-2603", provider_url: STEP_PLAN_QUOTE_BASIS.selected_provider_url,
    request_profile: "step-3.5-2603-low-json-schema-v1", query_cache_root: join(base, "query", String(member.index)),
    recorded_at: "2026-09-23T00:00:00.000Z", producer_commit: "a".repeat(40),
    max_output_tokens: 4096, output_byte_limit: 100000,
    budget: { schema_version: 1, work_units: 1_000_000, memory_bytes: 60_000_000,
      page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 } }));
  const input = { population: kind, dataset_sha256: digest, dataset_question_count: 500,
    membership_index_path, experiment_policy_reference: "authored-development-policy",
    exposure_reference: "authored-prior-exposure", members };
  return { root, metadata, input };
}

it("freezes ordered 20 and 50 membership without reading corpus, gold, or provider", () => {
  const forbidden = vi.fn(() => { throw new Error("external effect forbidden"); });
  vi.stubGlobal("fetch", forbidden);
  for (const kind of ["development20", "reused_readiness50"] as const) {
    const { root, input } = authoredPopulation(kind);
    const frozen = freezeLongMemEvalLazyPopulation(input, root);
    expect(readLongMemEvalLazyPopulation(root)).toEqual(frozen);
    expect(frozen.selection.selected_count).toBe(kind === "development20" ? 20 : 50);
    expect(frozen.selection.expected_cohort_counts).toEqual({ answerable: frozen.selection.selected_count, abstention: 0 });
    expect(frozen.formal_arm).toBe(false);
    expect(readChainArtifact(join(root, "population.json"))).toEqual(frozen);
  }
  expect(forbidden).not.toHaveBeenCalled();
});

it("keeps the CLI cutoff config physically separate from aggregate output", async () => {
  const { root, input } = authoredPopulation("development20");
  freezeLongMemEvalLazyPopulation(input, root);
  const physical = join(dirname(root), "physical-cutoff-config");
  mkdirSync(physical);
  const cutoffPath = join(physical, "cutoff.json");
  writeFileSync(cutoffPath, JSON.stringify({ cutoff_id: "cli", cutoff_at: "2026-09-23T00:01:00.000Z",
    predecessor_identity: null }));
  const invoke = async (configPath: string, evaluatorRoot: string) => {
    let error = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { error += String(chunk); return true; });
    try {
      const code = await runLongMemEvalSemanticLauncher(["observe-population", "--root", root,
        "--config", configPath, "--evaluator-root", evaluatorRoot]);
      return { code, error };
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  };
  const direct = await invoke(cutoffPath, physical);
  expect(direct).toMatchObject({ code: 2 });
  expect(direct.error).toMatch(/separate from producer and input roots/u);
  expect(readdirSync(physical)).toEqual(["cutoff.json"]);

  const alias = join(dirname(root), "cutoff-config-directory-alias");
  symlinkSync(physical, alias, "dir");
  const aliased = await invoke(join(alias, "cutoff.json"), physical);
  expect(aliased).toMatchObject({ code: 2 });
  expect(aliased.error).toMatch(/separate from producer and input roots/u);
  expect(readdirSync(physical)).toEqual(["cutoff.json"]);

  const separate = join(dirname(root), "separate-aggregate-evaluator");
  expect((await invoke(cutoffPath, separate)).code).toBe(0);
  expect(readChainArtifact(join(separate, "population-observation-cli.json"))).toMatchObject({
    primary: { eligible: 20, hits: 0, misses: 0, unknown: 20 }
  });
});

it("rejects altered order, overlap, cohort, dataset, and execution before any member effect", async () => {
  const { root, input } = authoredPopulation("reused_readiness50");
  expect(() => freezeLongMemEvalLazyPopulation({ ...input, members: [...input.members].reverse() }, root)).toThrow(/membership/u);
  expect(() => freezeLongMemEvalLazyPopulation({ ...input, members: input.members.slice(1) }, root)).toThrow(/membership/u);
  expect(() => freezeLongMemEvalLazyPopulation({ ...input, dataset_sha256: "b".repeat(64) }, root)).toThrow(/config differs/u);
  expect(() => freezeLongMemEvalLazyPopulation({ ...input, members: input.members.map((row, i) => i === 0
    ? { ...row, dataset_cohort: "abstention" } : row) }, root)).toThrow(/membership/u);
  expect(() => freezeLongMemEvalLazyPopulation({ ...input, members: input.members.map((row, i) => i === 0
    ? { ...row, prior_development_exposure: false } : row) }, root)).toThrow(/config differs/u);
  const metadata = JSON.parse(readFileSync(input.membership_index_path, "utf8"));
  metadata.reused50[0].question_id = metadata.development20[0].question_id;
  writeFileSync(input.membership_index_path, JSON.stringify(metadata));
  expect(() => freezeLongMemEvalLazyPopulation(input, root)).toThrow(/membership/u);
  await expect(runLongMemEvalLazyPopulationStage(root, input.members[0]!.question_id, "freeze")).rejects.toThrow();
});

it("pins native resource config and rejects evaluator aliases before writing population output", () => {
  const { root, input } = authoredPopulation("development20");
  freezeLongMemEvalLazyPopulation(input, root);
  const config = JSON.parse(readFileSync(input.members[0]!.native_config_path, "utf8"));
  config.max_output_tokens = 8192;
  writeFileSync(input.members[0]!.native_config_path, JSON.stringify(config));
  expect(() => readLongMemEvalLazyPopulation(root)).toThrow(/config changed/u);
  const other = authoredPopulation("development20");
  mkdirSync(other.input.members[0]!.native_root, { recursive: true });
  mkdirSync(dirname(other.input.members[0]!.evaluator_root), { recursive: true });
  symlinkSync(other.input.members[0]!.native_root, other.input.members[0]!.evaluator_root, "dir");
  expect(() => freezeLongMemEvalLazyPopulation(other.input, other.root)).toThrow(/evaluator root overlaps/u);
  const cross = authoredPopulation("development20");
  const firstConfig = JSON.parse(readFileSync(cross.input.members[0]!.native_config_path, "utf8"));
  mkdirSync(firstConfig.query_cache_root, { recursive: true });
  mkdirSync(dirname(cross.input.members[1]!.evaluator_root), { recursive: true });
  symlinkSync(firstConfig.query_cache_root, cross.input.members[1]!.evaluator_root, "dir");
  expect(() => freezeLongMemEvalLazyPopulation(cross.input, cross.root)).toThrow(/evaluator root overlaps/u);
});

it("keeps every held and unresolved member in separate fixed denominators without gold", async () => {
  for (const kind of ["development20", "reused_readiness50"] as const) {
    const { root, input } = authoredPopulation(kind);
    const evaluatorRoot = join(dirname(root), "aggregate-evaluator");
    const frozen = freezeLongMemEvalLazyPopulation({ ...input, members: input.members.map((member, index) =>
      index === 1 ? { ...member, execution_policy: "eligible" } : member) }, root);
    const cutoff = { cutoff_id: "initial", cutoff_at: "2026-09-23T00:00:00.000Z", predecessor_identity: null };
    await expect(observeLongMemEvalLazyPopulation(root, cutoff, root))
      .rejects.toThrow(/separate from producer and input roots/u);
    await expect(observeLongMemEvalLazyPopulation(root, cutoff, input.members[0]!.evaluator_root))
      .rejects.toThrow(/separate from producer and input roots/u);
    if (kind === "development20") {
      const configs = join(dirname(root), "configs");
      const physicalConfigs = join(dirname(root), "physical-native-configs");
      renameSync(configs, physicalConfigs);
      symlinkSync(physicalConfigs, configs, "dir");
      await expect(observeLongMemEvalLazyPopulation(root, cutoff, physicalConfigs))
        .rejects.toThrow(/separate from producer and input roots/u);
      expect(existsSync(join(root, "population-cutoff-initial.json"))).toBe(false);
    }
    const observed = await observeLongMemEvalLazyPopulation(root, cutoff, evaluatorRoot);
    expect(isContainedPath(evaluatorRoot, observed.path)).toBe(true);
    expect(observed.result.population_identity).toBe(chainIdentity(frozen));
    expect(observed.result.primary).toEqual({ eligible: frozen.selection.selected_count,
      hits: 0, misses: 0, unknown: frozen.selection.selected_count, lower_bound: 0, upper_bound: 1 });
    expect(observed.result.rows[0]).toMatchObject({ boundary: "not_started_held", outcome: "unknown" });
    expect(observed.result.rows[1]).toMatchObject({ boundary: "final_not_sealed", outcome: "unknown" });
    expect(observed.result.formal_target).toBe("not_run");
    expect(observed.result.producer_coverage).toMatchObject({ frozen_members: frozen.selection.selected_count,
      population_attempt_coverage_complete: false, population_authorized_attempts: null });
    expect(observed.result.producer_evidence?.scoped_authorized_attempts).toBeNull();
    const producerEntries = readdirSync(root).sort();
    const frozenBytes = readFileSync(join(root, "population.json"), "utf8");
    const cutoffBytes = readFileSync(join(root, "population-cutoff-initial.json"), "utf8");
    expect(await observeLongMemEvalLazyPopulation(root, cutoff, evaluatorRoot)).toEqual(observed);
    if (kind === "development20") {
      const cutoffPath = join(dirname(root), "cutoff-input.json");
      writeFileSync(cutoffPath, JSON.stringify(cutoff));
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(await runLongMemEvalSemanticLauncher(["observe-population", "--root", root,
          "--config", cutoffPath])).toBe(2);
        expect(await runLongMemEvalSemanticLauncher(["observe-population", "--root", root,
          "--config", cutoffPath, "--evaluator-root", evaluatorRoot])).toBe(0);
      } finally { stdout.mockRestore(); stderr.mockRestore(); }
    }
    expect(readdirSync(root).sort()).toEqual(producerEntries);
    expect(readFileSync(join(root, "population.json"), "utf8")).toBe(frozenBytes);
    expect(readFileSync(join(root, "population-cutoff-initial.json"), "utf8")).toBe(cutoffBytes);
    await expect(observeLongMemEvalLazyPopulation(root, { ...cutoff, cutoff_at: "2026-09-24T00:00:00.000Z" }, evaluatorRoot))
      .rejects.toThrow(/retained cutoff/u);
  }
});

it("deduplicates a copied native continuation attempt but counts an independent physical root", () => {
  const { root } = authoredPopulation("development20");
  const cacheA = join(dirname(root), "paid-a"), cacheB = join(dirname(root), "paid-b");
  mkdirSync(cacheA); mkdirSync(cacheB);
  const key = "b".repeat(64), identity = { model: "step-3.5-flash-2603",
    requestProfile: "step-3.5-2603-low-json-schema-v1" as const };
  const first = openExtractionAttemptLedger({ cacheRoot: cacheA, lineageDigest: "c".repeat(64),
    cacheIdentity: identity, startingMissing: 1, maximumAttempts: 1 });
  const ordinal = first.reserveAttemptOrdinal(key);
  first.recordTransportOutcome(key, { retryCount: 0, rateLimitRetries: 0,
    successfulRequestCount: 0, unknownRequestCount: 1 }, ordinal);
  first.abandonPendingShard(key, ordinal);
  forkSettledExtractionAttemptLedger({ cacheRoot: cacheA, predecessorLineageDigest: "c".repeat(64),
    predecessorLedgerSha256: first.snapshot().ledgerSha256, successorLineageDigest: "d".repeat(64),
    cacheIdentity: identity });
  const scope = { layer: "source" as const, cacheRoot: cacheA, model: identity.model,
    requestProfile: identity.requestProfile, keys: [key] };
  expect(inspectPopulationAttemptScopes([scope, scope])).toMatchObject({
    scoped_authorized_attempts: 1, observed_raw_receipts: 0, scoped_unknown_usage_attempts: 1,
    scoped_reported_input_tokens: 0, actual_spend: null,
    attempts: [{ ledger_lineages: ["c".repeat(64), "d".repeat(64)] }] });
  const independent = openExtractionAttemptLedger({ cacheRoot: cacheB, lineageDigest: "e".repeat(64),
    cacheIdentity: identity, startingMissing: 1, maximumAttempts: 1 });
  independent.reserveAttemptOrdinal(key);
  expect(inspectPopulationAttemptScopes([scope, { ...scope, cacheRoot: cacheB }])).toMatchObject({
    scoped_authorized_attempts: 2, scoped_unknown_usage_attempts: 2, actual_spend: null });
});

it("keeps abstention outside the answerable metric while an early failure remains unknown", () => {
  expect(summarizeLongMemEvalOutcomes([
    { cohort: "answerable", outcome: "hit" }, { cohort: "answerable", outcome: "miss" },
    { cohort: "answerable", outcome: "unknown" }, { cohort: "answerable", outcome: "unknown" },
    { cohort: "answerable", outcome: "unknown" }, { cohort: "abstention", outcome: "uncalibrated" }
  ])).toEqual({ eligible: 5, hits: 1, misses: 1, unknown: 3, lower_bound: 0.2, upper_bound: 0.8 });
});

function question(id: string): LongMemEvalQuestion {
  return { question_id: id, question_type: "single_session", question: `What did ${id} complete?`,
    answer: "authored fixture", question_date: "2026-09-23",
    haystack_session_ids: [`${id}-session`], haystack_dates: ["2023-09-10"],
    haystack_sessions: [[{ role: "user", content: `I completed ${id}.`, has_answer: true }]],
    answer_session_ids: [`${id}-session`] };
}

it("runs one explicit member through native SQLite first exposure and preserves nineteen other N rows", async () => {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "step-3.5-flash-2603");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "step-3.5-2603-low-json-schema-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  const forbiddenFetch = vi.fn(async () => { throw new Error("provider must not be called"); });
  vi.stubGlobal("fetch", forbiddenFetch);
  const { root, input, metadata } = authoredPopulation("development20");
  const evaluatorRoot = join(dirname(root), "aggregate-evaluator");
  const ids = [...metadata.development20, ...metadata.reused50].map(row => row.question_id);
  await writeDataset([...ids, ...Array.from({ length: 430 }, (_, i) => `other-${i}`)].map(question));
  const census = await censusCompleteSourceRecords({ population: "longmemeval_s", dataDir, pinnedMetaRoot,
    questionWindow: { offset: 0, limit: 1 } });
  metadata.provenance.dataset.sha256 = census.dataset_sha256;
  writeFileSync(input.membership_index_path, JSON.stringify(metadata));
  const member = { ...input.members[0]!, source_cache_root: cacheRoot, execution_policy: "eligible" as const };
  const second = { ...input.members[1]!, execution_policy: "eligible" as const };
  const third = { ...input.members[2]!, execution_policy: "eligible" as const };
  const members = [member, second, third, ...input.members.slice(3)];
  for (const row of members) {
    const config = JSON.parse(readFileSync(row.native_config_path, "utf8"));
    config.dataset_sha256 = census.dataset_sha256;
    config.data_dir = dataDir; config.pinned_meta_root = pinnedMetaRoot;
    if (row.question_id === second.question_id) config.data_dir = join(dirname(root), "missing-data");
    if (row.question_id === member.question_id) config.source_cache_roots = [cacheRoot];
    writeFileSync(row.native_config_path, JSON.stringify(config));
  }
  const preflight = await preflightSourceSemanticInteractive({ variant: "longmemeval_s", cacheRoot,
    dataDir, pinnedMetaRoot, offset: 0, limit: 1, sourcePacking: "complete-source",
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION });
  mkdirSync(dirname(member.source_preflight_path), { recursive: true });
  writeFileSync(member.source_preflight_path, JSON.stringify(preflight));
  freezeLongMemEvalLazyPopulation({ ...input, dataset_sha256: census.dataset_sha256, members }, root);
  const before = await observeLongMemEvalLazyPopulation(root, { cutoff_id: "before",
    cutoff_at: "2026-09-23T00:01:00.000Z", predecessor_identity: null }, evaluatorRoot);
  expect(before.result.primary).toMatchObject({ eligible: 20, hits: 0, misses: 0, unknown: 20 });
  unlinkSync(before.path);
  const recoveredBefore = await observeLongMemEvalLazyPopulation(root, { cutoff_id: "before",
    cutoff_at: "2026-09-23T00:01:00.000Z", predecessor_identity: null }, evaluatorRoot);
  expect(recoveredBefore.result.primary).toMatchObject({ hits: 0, misses: 0, unknown: 20 });
  expect(recoveredBefore.result.cutoff_identity).toBe(before.result.cutoff_identity);
  await expect(measureLongMemEvalLazyFirstExposure({ root: member.native_root,
    preparedPath: join(root, "missing-prepared.json"), sourcePreflightPath: member.source_preflight_path,
    sourceCacheRoot: cacheRoot, lazyRoot: member.lazy_root,
    evaluatorRoot: member.evaluator_root })).rejects.toThrow();
  await runLongMemEvalLazyPopulationStage(root, member.question_id, "freeze");
  await runLongMemEvalLazyPopulationStage(root, third.question_id, "freeze");
  const queryOnly = await observeLongMemEvalLazyPopulation(root, { cutoff_id: "query-only",
    cutoff_at: "2026-09-23T00:01:30.000Z", predecessor_identity: chainIdentity(recoveredBefore.result) }, evaluatorRoot);
  expect(queryOnly.result.rows[0]?.attempt_scopes.map(scope => scope.layer)).toEqual(["query"]);
  expect(queryOnly.result.rows[2]?.attempt_scopes.map(scope => scope.layer)).toEqual(["query"]);
  expect(queryOnly.result.producer_coverage).toMatchObject({ members_with_scopes: 0,
    population_attempt_coverage_complete: false, population_authorized_attempts: null });
  for (const stage of ["freeze", "prepare", "bind", "window", "final", "exposure"] as const) {
    const completed = await runLongMemEvalLazyPopulationStage(root, member.question_id, stage);
    expect(completed.state).toBe("completed");
  }
  await expect(runLongMemEvalLazyPopulationStage(root, second.question_id, "freeze")).rejects.toThrow();
  expect(await runLongMemEvalLazyPopulationStage(root, member.question_id, "exposure")).toMatchObject({ state: "completed" });
  const after = await observeLongMemEvalLazyPopulation(root, { cutoff_id: "after",
    cutoff_at: "2026-09-23T00:02:00.000Z", predecessor_identity: chainIdentity(queryOnly.result) }, evaluatorRoot);
  expect(after.result.rows).toHaveLength(20);
  expect(after.result.rows[0]?.first_exposure_identity).toMatch(/^[a-f0-9]{64}$/u);
  expect(after.result.rows[0]).toMatchObject({ outcome: "hit", measurement_path: expect.any(String) });
  expect(after.result.rows[1]).toMatchObject({ outcome: "unknown", measurement_path: null });
  expect(after.result.rows[1]?.boundary).toMatch(/^freeze_failed:/u);
  expect(after.result.rows[2]).toMatchObject({ outcome: "unknown", boundary: "final_not_sealed" });
  expect(after.result.rows.slice(3).every(row => row.outcome === "unknown" && row.boundary === "not_started_held")).toBe(true);
  expect(after.result.primary.eligible).toBe(20);
  expect(after.result.primary).toMatchObject({ hits: 1, misses: 0, unknown: 19,
    lower_bound: 0.05, upper_bound: 1 });
  expect(after.result.producer_coverage).toMatchObject({ frozen_members: 20,
    population_attempt_coverage_complete: false, population_authorized_attempts: null });
  expect(after.result.primary.hits + after.result.primary.misses + after.result.primary.unknown).toBe(20);
  expect(readChainArtifact(after.path)).toEqual(after.result);
  expect(forbiddenFetch).not.toHaveBeenCalled();
  const memberCutoff = { cutoff_id: "member-input", cutoff_at: "2026-09-23T00:02:15.000Z", predecessor_identity: null };
  const memberCutoffPath = join(member.evaluator_root, "cutoff-input.json");
  writeFileSync(memberCutoffPath, JSON.stringify(memberCutoff));
  const memberEntries = readdirSync(member.evaluator_root).sort();
  const cliAggregate = join(dirname(root), "member-input-aggregate");
  const invokeCli = async (configPath: string, outputPath: string) => {
    let error = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { error += String(chunk); return true; });
    try {
      const code = await runLongMemEvalSemanticLauncher(["observe-population", "--root", root,
        "--config", configPath, "--evaluator-root", outputPath]);
      return { code, error };
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  };
  const directMemberInput = await invokeCli(memberCutoffPath, cliAggregate);
  expect(directMemberInput.code).toBe(2);
  expect(directMemberInput.error).toMatch(/separate from producer and input roots/u);
  expect(readdirSync(member.evaluator_root).sort()).toEqual(memberEntries);
  expect(existsSync(cliAggregate)).toBe(false);
  expect(existsSync(join(root, "population-cutoff-member-input.json"))).toBe(false);
  const memberAlias = join(dirname(root), "member-input-directory-alias");
  symlinkSync(member.evaluator_root, memberAlias, "dir");
  const aliasedMemberInput = await invokeCli(join(memberAlias, "cutoff-input.json"), cliAggregate);
  expect(aliasedMemberInput.code).toBe(2);
  expect(aliasedMemberInput.error).toMatch(/separate from producer and input roots/u);
  expect(readdirSync(member.evaluator_root).sort()).toEqual(memberEntries);
  unlinkSync(memberAlias); unlinkSync(memberCutoffPath);
  const safeCutoffPath = join(dirname(root), "separate-cutoff-input.json");
  writeFileSync(safeCutoffPath, JSON.stringify({ ...memberCutoff, cutoff_id: "separate-input" }));
  const safeAggregate = join(dirname(root), "separate-member-aggregate");
  expect((await invokeCli(safeCutoffPath, safeAggregate)).code).toBe(0);
  expect(readChainArtifact(join(safeAggregate, "population-observation-separate-input.json"))).toMatchObject({
    primary: { eligible: 20, hits: 1, misses: 0, unknown: 19 }
  });
  const peerFreeze = readChainArtifact(join(third.native_root, "freeze.json")) as {
    selected: { query_key: string }[]; config: { query_cache_root: string } };
  const peerBucket = join(peerFreeze.config.query_cache_root, peerFreeze.selected[0]!.query_key.slice(0, 2));
  const physicalPeerBucket = join(dirname(root), "physical-peer-query-bucket");
  mkdirSync(dirname(peerBucket), { recursive: true });
  const hadPeerBucket = existsSync(peerBucket);
  if (hadPeerBucket) renameSync(peerBucket, physicalPeerBucket);
  symlinkSync(member.evaluator_root, peerBucket, "dir");
  const beforePeerEntries = readdirSync(member.evaluator_root).sort();
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "peer-member-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: chainIdentity(after.result) }, evaluatorRoot))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(readdirSync(member.evaluator_root).sort()).toEqual(beforePeerEntries);
  expect(existsSync(join(root, "population-cutoff-peer-member-output.json"))).toBe(false);
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "after",
    cutoff_at: "2026-09-23T00:02:00.000Z", predecessor_identity: chainIdentity(queryOnly.result) }, evaluatorRoot))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(readChainArtifact(after.path)).toEqual(after.result);
  unlinkSync(peerBucket);
  if (hadPeerBucket) renameSync(physicalPeerBucket, peerBucket);
  const sourceKey = preflight.selected_keys[0]!;
  const sourceRawBucket = join(cacheRoot, "provider-raw", sourceKey.slice(0, 2));
  const physicalSourceRaw = join(dirname(root), "physical-member-source-raw");
  mkdirSync(dirname(sourceRawBucket), { recursive: true });
  const hadSourceRawBucket = existsSync(sourceRawBucket);
  if (hadSourceRawBucket) renameSync(sourceRawBucket, physicalSourceRaw);
  else mkdirSync(physicalSourceRaw);
  symlinkSync(physicalSourceRaw, sourceRawBucket, "dir");
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "source-raw-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: chainIdentity(after.result) }, physicalSourceRaw))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(existsSync(join(root, "population-cutoff-source-raw-output.json"))).toBe(false);
  expect(readdirSync(physicalSourceRaw).some(name => name.startsWith("measurement-") || name.startsWith("population-cutoff-")))
    .toBe(false);
  unlinkSync(sourceRawBucket);
  if (hadSourceRawBucket) renameSync(physicalSourceRaw, sourceRawBucket);
  else rmSync(physicalSourceRaw, { recursive: true });
  const memberFreeze = readChainArtifact(join(member.native_root, "freeze.json")) as {
    selected: { query_key: string }[]; config: { query_cache_root: string } };
  const physicalQueryBucket = join(dirname(root), "physical-member-query-bucket");
  const queryBucket = join(memberFreeze.config.query_cache_root, memberFreeze.selected[0]!.query_key.slice(0, 2));
  mkdirSync(dirname(queryBucket), { recursive: true });
  const hadQueryBucket = existsSync(queryBucket);
  if (hadQueryBucket) renameSync(queryBucket, physicalQueryBucket);
  else mkdirSync(physicalQueryBucket);
  symlinkSync(physicalQueryBucket, queryBucket, "dir");
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "query-cache-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: chainIdentity(after.result) }, physicalQueryBucket))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(readdirSync(physicalQueryBucket).some(name => name.startsWith("measurement-") || name.startsWith("population-cutoff-")))
    .toBe(false);
  unlinkSync(queryBucket);
  if (hadQueryBucket) renameSync(physicalQueryBucket, queryBucket);
  else rmSync(physicalQueryBucket, { recursive: true });
  const final = readChainArtifact(join(member.lazy_root, "final.json")) as { final_chain_root: string };
  const exposure = readChainArtifact(join(member.lazy_root, "first-exposure.json")) as { replay_identity: string };
  const replayRows = join(final.final_chain_root, `replay-${exposure.replay_identity}`);
  const physicalRows = join(dirname(root), "physical-member-replay-rows");
  renameSync(replayRows, physicalRows);
  symlinkSync(physicalRows, replayRows, "dir");
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "unsafe-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: chainIdentity(after.result) }, physicalRows))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(existsSync(join(root, "population-cutoff-unsafe-output.json"))).toBe(false);
  const exposurePath = join(member.lazy_root, "first-exposure.json"), exposureBytes = readFileSync(exposurePath, "utf8");
  const unrelatedExposureError = { ...exposure, final_identity: "invalid" };
  writeFileSync(exposurePath, JSON.stringify({ identity: chainIdentity(unrelatedExposureError), payload: unrelatedExposureError }));
  const reservationPath = join(member.lazy_root, "first-exposure.reserved.json");
  const reservationBytes = readFileSync(reservationPath, "utf8");
  const reservation = readChainArtifact(reservationPath) as Record<string, unknown>;
  const unrelatedReservationError = { ...reservation, final_identity: "invalid" };
  writeFileSync(reservationPath, JSON.stringify({ identity: chainIdentity(unrelatedReservationError), payload: unrelatedReservationError }));
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "unavailable-exposure-row-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: null }, physicalRows))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(existsSync(join(root, "population-cutoff-unavailable-exposure-row-output.json"))).toBe(false);
  writeFileSync(exposurePath, exposureBytes);
  writeFileSync(reservationPath, reservationBytes);
  const finalPath = join(member.lazy_root, "final.json"), finalBytes = readFileSync(finalPath, "utf8");
  const unrelatedFinalError = { ...final, final_snapshot_path: null };
  writeFileSync(finalPath, JSON.stringify({ identity: chainIdentity(unrelatedFinalError), payload: unrelatedFinalError }));
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "unavailable-final-field-row-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: null }, physicalRows))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(existsSync(join(root, "population-cutoff-unavailable-final-field-row-output.json"))).toBe(false);
  writeFileSync(finalPath, finalBytes);
  const prepareStage = readChainArtifact(join(root, "stages", String(member.index).padStart(5, "0"),
    "prepare.completed.json")) as { result_path: string };
  const preparedBytes = readFileSync(prepareStage.result_path, "utf8");
  const prepared = readChainArtifact(prepareStage.result_path) as { rows: { status: string; chain_root?: string }[] };
  const initialChain = prepared.rows.find(row => row.status === "prepared")?.chain_root;
  if (initialChain === undefined) throw new Error("prepared member chain required");
  const physicalInitialChain = join(dirname(root), "physical-initial-chain");
  renameSync(initialChain, physicalInitialChain);
  symlinkSync(physicalInitialChain, initialChain, "dir");
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "initial-chain-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: chainIdentity(after.result) }, physicalInitialChain))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(existsSync(join(root, "population-cutoff-initial-chain-output.json"))).toBe(false);
  const windowPath = join(member.lazy_root, "window.json"), windowBytes = readFileSync(windowPath, "utf8");
  const window = readChainArtifact(windowPath) as Record<string, unknown>;
  const unrelatedWindowError = { ...window, query_key: null };
  writeFileSync(windowPath, JSON.stringify({ identity: chainIdentity(unrelatedWindowError), payload: unrelatedWindowError }));
  const unrelatedPreparedError = { ...prepared, rows: prepared.rows.map(row => row.status === "prepared"
    ? { ...row, publication_path: null } : row) };
  writeFileSync(prepareStage.result_path, JSON.stringify({ identity: chainIdentity(unrelatedPreparedError), payload: unrelatedPreparedError }));
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "unavailable-initial-field-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: null }, physicalInitialChain))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(existsSync(join(root, "population-cutoff-unavailable-initial-field-output.json"))).toBe(false);
  const retainedReplayPath = (readChainArtifact(exposurePath) as { replay_path: string }).replay_path;
  const replayBytes = readFileSync(retainedReplayPath, "utf8");
  const replay = readChainArtifact(retainedReplayPath) as { rows: Array<Record<string, unknown>> };
  const unrelatedReplayError = { ...replay, rows: replay.rows.map(row => ({ ...row, query_key: null })) };
  writeFileSync(retainedReplayPath, JSON.stringify({ identity: chainIdentity(unrelatedReplayError), payload: unrelatedReplayError }));
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "unavailable-query-key-row-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: null }, physicalRows))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(existsSync(join(root, "population-cutoff-unavailable-query-key-row-output.json"))).toBe(false);
  writeFileSync(retainedReplayPath, replayBytes);
  writeFileSync(windowPath, windowBytes);
  writeFileSync(prepareStage.result_path, preparedBytes);
  const originalQuestion = join(member.native_root, "questions", String(member.index).padStart(5, "0"));
  const physicalQuestion = join(dirname(root), "physical-original-question");
  renameSync(originalQuestion, physicalQuestion);
  symlinkSync(physicalQuestion, originalQuestion, "dir");
  const untrustedFinal = JSON.parse(finalBytes) as { identity: string; payload: unknown };
  writeFileSync(finalPath, JSON.stringify({ ...untrustedFinal, identity: "0".repeat(64) }));
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "unavailable-final-row-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: chainIdentity(after.result) }, physicalRows))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(existsSync(join(root, "population-cutoff-unavailable-final-row-output.json"))).toBe(false);
  writeFileSync(finalPath, finalBytes);
  writeFileSync(finalPath, "{");
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "unavailable-member-output",
    cutoff_at: "2026-09-23T00:02:30.000Z", predecessor_identity: chainIdentity(after.result) }, physicalQuestion))
    .rejects.toThrow(/separate from producer and input roots/u);
  expect(existsSync(join(root, "population-cutoff-unavailable-member-output.json"))).toBe(false);
  writeFileSync(finalPath, finalBytes);
  const requestedPath = join(root, "stages", String(second.index).padStart(5, "0"), "freeze.requested.json");
  const foreignStage = { ...readChainArtifact(requestedPath) as object, question_id: member.question_id };
  writeFileSync(requestedPath, JSON.stringify({ identity: chainIdentity(foreignStage), payload: foreignStage }));
  const foreign = await observeLongMemEvalLazyPopulation(root, { cutoff_id: "foreign",
    cutoff_at: "2026-09-23T00:03:00.000Z", predecessor_identity: chainIdentity(after.result) }, evaluatorRoot);
  expect(foreign.result.rows[1]).toMatchObject({ outcome: "unknown", measurement_path: null });
  expect(foreign.result.rows[1]?.boundary).toMatch(/another frozen member/u);
  const nativePath = after.result.rows[0]!.measurement_path!;
  const native = readChainArtifact(nativePath) as { rows: Array<{ question_id: string; outcome: string }>; primary: object };
  const forgedNative = { ...native, rows: native.rows.map(row => row.question_id === member.question_id
    ? { ...row, outcome: "miss" } : row), primary: { ...native.primary, hits: 0, misses: 1, unknown: 0,
      lower_bound: 0, upper_bound: 0 } };
  writeFileSync(nativePath, JSON.stringify({ identity: chainIdentity(forgedNative), payload: forgedNative }));
  const forgedResult = { ...after.result,
    rows: after.result.rows.map((row, index) => index === 0 ? { ...row, outcome: "miss" } : row),
    primary: { ...after.result.primary, hits: 0, misses: 1, lower_bound: 0, upper_bound: 0.95 } };
  writeFileSync(after.path, JSON.stringify({ identity: chainIdentity(forgedResult), payload: forgedResult }));
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "after",
    cutoff_at: "2026-09-23T00:02:00.000Z", predecessor_identity: chainIdentity(queryOnly.result) }, evaluatorRoot))
    .rejects.toThrow(/immutable semantic chain stage conflict|retained lazy measurement differs/u);
  await expect(observeLongMemEvalLazyPopulation(root, { cutoff_id: "later",
    cutoff_at: "2026-09-23T00:04:00.000Z", predecessor_identity: chainIdentity(foreign.result) }, evaluatorRoot))
    .rejects.toThrow(/immutable semantic chain stage conflict|retained lazy measurement differs/u);
}, 120000);
