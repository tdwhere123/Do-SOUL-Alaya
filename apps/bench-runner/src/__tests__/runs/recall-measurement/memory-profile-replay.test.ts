import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { buildReady, configuration, fixture, publishSource, WORKSPACE } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-cache/workset.js";
import { SemanticChainConfigSchema, SemanticChainPlanSchema, chainIdentity, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { inspectSemanticChainSourceIndex } from "../../../runs/recall-measurement/source-index-binding.js";
import { readSemanticChainProposalResults, semanticChainCacheInputPaths, semanticChainPreparationIdentity } from "../../../runs/recall-measurement/inputs.js";
import { admitSemanticChainReplay, closeSemanticChainReplayFromDurableRows, inspectSemanticChainReplayTarget,
  measureSemanticChain, replaySemanticChain } from "../../../runs/recall-measurement/replay.js";
import { admitSemanticChainLibraryCapture, captureSemanticChainLibrary } from "../../../runs/recall-measurement/library-capture.js";
import { executeOrdinaryRecallEntry } from "../../../runs/recall-measurement/ordinary/ordinary-entry-execution.js";
import { admitOrdinaryFrozenExecution } from "../../../runs/recall-measurement/ordinary/ordinary-frozen-replay.js";
import { ORDINARY_RECALL_ENTRY_CONTRACT, ORDINARY_RECALL_PUBLIC_PAGE_SLOTS, ORDINARY_RECALL_OBSERVED_SLOT_TARGET,
  ORDINARY_RECALL_UNMAPPED_DIMENSIONS, mapOrdinaryRecallScope } from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); isolation.restore(); });

/** A real sealed SQLite generation and deterministic retained receipts; no model or provider is used. */
function replayFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "memory-profile-replay-"))); roots.push(root);
  const snapshot = join(root, "snapshot.sqlite"), environment = fixture(snapshot);
  publishSource(environment, "Blue stone.");
  buildReady(environment, configuration({ provider_kind: "local_onnx", model_id: "fixture-source" }));
  environment.database.close({ optimize: false });
  const budget = { schema_version: 1, work_units: 10_000_000, memory_bytes: 60_000_000,
    page_budget: 10_000, finalization_reserve: 50_000, min_envelope: 10 } as const;
  const inspected = inspectSemanticChainSourceIndex(snapshot, WORKSPACE, budget);
  if (!inspected.complete || inspected.index === null) throw new Error("fixture Source generation must be sealed");
  const index = inspected.index, memoryCache = join(root, "memory-cache");
  const memory = { cache_root: memoryCache, model_id: "fixture-memory", artifact_digest: `sha256:${"c".repeat(64)}` };
  const profile = configuration({ provider_kind: "local_onnx", model_id: memory.model_id, artifact_digest: memory.artifact_digest,
    dimensions: 384, max_input_tokens: 512, window_bytes: 4 }).profile;
  const memoryProfile = { status: "ready" as const, profile, profile_id: sourceIndexProfileId(profile, fieldContractSha256) };
  const readiness = { status: "ready" as const, dimensions: 384, profile: memoryProfile };
  const execution = { cache_root: join(root, "source-cache"), model_id: "fixture-source", source_scope: "separate" as const,
    artifact_digest: index.configuration.profile.artifact_digest, memory, memory_warmup: "eager" as const,
    windowing: index.configuration.profile.windowing };
  const snapshotSha = hashRegularFileNoFollow(snapshot), preparation = join(root, "source-preparation.json");
  const report = { contract: "semantic-chain-source-preparation-v1", execution, snapshot_path: snapshot, snapshot_sha256: snapshotSha,
    workspace_id: WORKSPACE, index, memory_profile: memoryProfile, memory_readiness: { status: "ready", dimensions: 384 },
    setup: { status: "settled", binding: { status: "ready", profile_id: index.profile_id, profile: index.configuration.profile } } };
  writeChainArtifact(preparation, report);
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot, snapshot_sha256: snapshotSha,
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-22T00:00:00.000Z",
    workspace_id: WORKSPACE, run_id: "fixture-run", source_index: { ...execution, kind: "cached_local", index,
      preparation_path: preparation, preparation_identity: chainIdentity(report) },
    query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
      model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1", provider_url: "http://127.0.0.1:9",
      items: [{ original_query: "What color is the stone?" }] }),
    query_cache_root: join(root, "query-cache"), correspondence_cache_root: join(root, "correspondence-cache"),
    max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0,
    access_policy: "query-conditioned-v1", authorized_scopes: { mode: "named", scopes: ["project"] },
    budget, output_byte_limit: 1_000_000 });
  const results = readSemanticChainProposalResults(config.query_workset, config.query_cache_root, config.max_output_tokens);
  const query = results[0]!;
  const plan = SemanticChainPlanSchema.parse({ contract: "source-semantic-chain-plan-v7",
    input_identity: semanticChainPreparationIdentity(config, results), config, correspondence_workset: null,
    queries: [{ query_key: query.line.key, original_query: query.line.original_query, raw_digest: null,
      status: "raw_ready", reason: "unattempted", query_semantics_unavailable: "absent", descriptors: [], discovery_trace: [],
      discovery_pages: 0, discovery_open: false, unvisited_source_interpretation_count: 0, discovery_truncated: false }] });
  const chainRoot = join(root, "chain"); writeChainArtifact(join(chainRoot, "prepare.json"), plan);
  const target = inspectSemanticChainReplayTarget(chainRoot, "retained"), rowPath = target.rowPaths.get(query.line.key)!;
  const row = { query_key: query.line.key, status: "native_unavailable", reason: "fixture", first_exposure: null, correspondence_outcomes: [] };
  writeChainArtifact(rowPath, row);
  writeChainArtifact(`${rowPath}.reserved`, { replay_identity: target.identity, query_key: query.line.key });
  const receiptRoot = join(chainRoot, `replay-${target.identity}`);
  return { root, chainRoot, config, plan, target, row, rowPath, readiness, memoryProfile, memoryCache, receiptRoot };
}

it.each(["both missing", "final missing", "final differs", "both disagree with preparation"] as const)(
  "refuses durable closure and retained admission when Memory evidence is %s", async state => {
  const f = replayFixture();
  // A completed preparation-level receipt is not replay-level evidence.
  writeChainArtifact(join(f.chainRoot, "memory-embedding-readiness.json"), f.readiness);
  writeChainArtifact(join(f.chainRoot, "memory-embedding-profile-final.json"), f.memoryProfile);
  const changedProfile = { ...f.memoryProfile.profile, artifact_digest: `sha256:${"d".repeat(64)}` };
  const changed = { status: "ready" as const, profile: changedProfile, profile_id: sourceIndexProfileId(changedProfile, fieldContractSha256) };
  if (state !== "both missing") writeChainArtifact(join(f.receiptRoot, "memory-embedding-readiness.json"),
    state === "both disagree with preparation" ? { ...f.readiness, profile: changed } : f.readiness);
  if (state === "final differs" || state === "both disagree with preparation") {
    writeChainArtifact(join(f.receiptRoot, "memory-embedding-profile-final.json"), changed);
  }
  await expect(closeSemanticChainReplayFromDurableRows(f.chainRoot)).rejects.toThrow(/Memory embedding profile/u);
  expect(existsSync(f.target.output)).toBe(false);
  await expect(replaySemanticChain(f.chainRoot)).rejects.toThrow(/Memory embedding profile/u);
  writeChainArtifact(f.target.output, { contract: "source-semantic-chain-replay-v3", plan_identity: chainIdentity(f.plan),
    identity: f.target.identity, arm: "retained", provider_calls: 0, rows: [f.row] });
  expect(() => admitSemanticChainReplay(f.chainRoot, f.target.output)).toThrow(/Memory embedding profile/u);
  await expect(replaySemanticChain(f.chainRoot)).rejects.toThrow(/Memory embedding profile/u);
}, 60_000);

it("admits a completed replay and protects its Memory cache across consumer outputs", async () => {
  const f = replayFixture();
  writeChainArtifact(join(f.receiptRoot, "memory-embedding-readiness.json"), f.readiness);
  writeChainArtifact(join(f.receiptRoot, "memory-embedding-profile-final.json"), f.memoryProfile);
  const closed = await closeSemanticChainReplayFromDurableRows(f.chainRoot);
  if (closed === null) throw new Error("complete fixture rows must close");
  expect(admitSemanticChainReplay(f.chainRoot, closed.path).replay.rows[0]?.status).toBe("native_unavailable");
  expect(semanticChainCacheInputPaths({ config: f.config })).toContain(f.memoryCache);
  await expect(executeOrdinaryRecallEntry({ config: f.config, root: join(f.memoryCache, "ordinary"),
    queries: [{ query_key: f.row.query_key, original_query: f.plan.queries[0]!.original_query }] })).rejects.toThrow(/separate/u);
  expect(() => measureSemanticChain(f.chainRoot, closed.path, [], join(f.memoryCache, "evaluator"))).toThrow(/separate/u);
  await expect(captureSemanticChainLibrary(f.chainRoot, join(f.memoryCache, "library"), { maxPages: 1 })).rejects.toThrow(/separate/u);
  expect(isolation.violations).toEqual([]);
}, 60_000);

it("preserves an all-blocked replay without inventing a Memory execution receipt", async () => {
  const f = replayFixture(), root = join(f.root, "blocked");
  const query = f.plan.queries[0]!;
  const plan = { ...f.plan, queries: [{ query_key: query.query_key, original_query: query.original_query,
    raw_digest: query.raw_digest, status: "blocked", reason: "discovery_unavailable: fixture" }] };
  writeChainArtifact(join(root, "prepare.json"), plan);
  const closed = await closeSemanticChainReplayFromDurableRows(root);
  if (closed === null) throw new Error("blocked denominator should close without a daemon");
  expect(admitSemanticChainReplay(root, closed.path).replay.rows[0]?.status).toBe("blocked");
  expect(existsSync(join(root, "memory-embedding-readiness.json"))).toBe(false);
}, 60_000);

it.each(["reservation remains", "no row or reservation"] as const)("does not issue a missing row using an earlier completed Memory receipt (%s)", async state => {
  const f = replayFixture();
  writeChainArtifact(join(f.receiptRoot, "memory-embedding-readiness.json"), f.readiness);
  writeChainArtifact(join(f.receiptRoot, "memory-embedding-profile-final.json"), f.memoryProfile);
  unlinkSync(f.rowPath);
  if (state === "no row or reservation") unlinkSync(`${f.rowPath}.reserved`);
  expect(await closeSemanticChainReplayFromDurableRows(f.chainRoot)).toBeNull();
  await expect(replaySemanticChain(f.chainRoot)).rejects.toThrow(/incomplete durable rows/u);
  expect(existsSync(f.rowPath)).toBe(false);
}, 60_000);

it.each(["missing", "changed", "matching"] as const)("checks Memory receipts before admitting a retained library page (%s)", state => {
  const f = replayFixture(), output = join(f.root, "library");
  const material = { contract: "source-semantic-library-capture-v1", mode: "library" as const, max_pages: 1 as const,
    execution_observation: "disabled" as const, output_root: output, plan_identity: chainIdentity(f.plan),
    correspondence_identity: f.target.identity, arm: "retained" as const };
  const identity = chainIdentity(material), directory = join(output, f.row.query_key);
  writeChainArtifact(join(output, "capture-owner.json"), { ...material, identity });
  writeChainArtifact(join(directory, "initial.json"), f.row);
  writeChainArtifact(join(directory, "initial.json.reserved"), { replay_identity: identity, query_key: f.row.query_key });
  writeChainArtifact(join(output, "memory-embedding-readiness.json"), f.readiness);
  if (state !== "missing") {
    const changedProfile = { ...f.memoryProfile.profile, artifact_digest: `sha256:${"d".repeat(64)}` };
    writeChainArtifact(join(output, "memory-embedding-profile-final.json"), state === "matching" ? f.memoryProfile :
      { status: "ready", profile: changedProfile, profile_id: sourceIndexProfileId(changedProfile, fieldContractSha256) });
  }
  if (state === "matching") expect(admitSemanticChainLibraryCapture(f.chainRoot, output).rows[0]).toMatchObject({ status: "partial" });
  else expect(() => admitSemanticChainLibraryCapture(f.chainRoot, output)).toThrow(/Memory embedding profile/u);
}, 60_000);

it("checks Memory receipts before returning a retained ordinary result", async () => {
  const f = replayFixture(), output = join(f.root, "ordinary"), query = { query_key: f.row.query_key,
    original_query: f.plan.queries[0]!.original_query };
  const mapping = { status: "mapped", scope_class: "project", max_results: ORDINARY_RECALL_PUBLIC_PAGE_SLOTS,
    observed_slot_target: ORDINARY_RECALL_OBSERVED_SLOT_TARGET, unmapped_dimensions: [...ORDINARY_RECALL_UNMAPPED_DIMENSIONS] };
  const costs = { status: "unavailable", reason: "fixture" };
  const entry = { contract: ORDINARY_RECALL_ENTRY_CONTRACT,
    input_identity: chainIdentity({ contract: ORDINARY_RECALL_ENTRY_CONTRACT, config: f.config, mapping, queries: [query] }),
    config_identity: chainIdentity(f.config), mapping, consumer_model_calls: 0, rows: [{ ...query, status: "unavailable", reason: "fixture",
      snapshot_identity: null, pages: [], page_count: 0, stop_cause: "unavailable", first_exposure: null, source_intervals: [],
      unobserved_counters: [], costs: { work_units: costs, read_bytes: costs, latency_ms: costs } }] };
  writeChainArtifact(join(output, "ordinary-entry.json"), entry);
  const frozen = { executionRoot: f.root, config: f.config, query };
  await expect(executeOrdinaryRecallEntry({ config: f.config, root: output, queries: [query] })).rejects.toThrow(/Memory embedding profile/u);
  expect(() => admitOrdinaryFrozenExecution(frozen)).toThrow(/Memory embedding profile/u);
  writeChainArtifact(join(output, "memory-embedding-readiness.json"), f.readiness);
  expect(() => admitOrdinaryFrozenExecution(frozen)).toThrow(/Memory embedding profile/u);
  writeChainArtifact(join(output, "memory-embedding-profile-final.json"), f.memoryProfile);
  expect((await executeOrdinaryRecallEntry({ config: f.config, root: output, queries: [query] })).rows[0]?.status).toBe("unavailable");
  expect(admitOrdinaryFrozenExecution(frozen)).toMatchObject({ capture_contract: ORDINARY_RECALL_ENTRY_CONTRACT, pages: [], previews: [] });

  const changedRoot = join(f.root, "changed"), changedOutput = join(changedRoot, "ordinary");
  const changedProfile = { ...f.memoryProfile.profile, artifact_digest: `sha256:${"d".repeat(64)}` };
  writeChainArtifact(join(changedOutput, "ordinary-entry.json"), entry);
  writeChainArtifact(join(changedOutput, "memory-embedding-readiness.json"), f.readiness);
  writeChainArtifact(join(changedOutput, "memory-embedding-profile-final.json"),
    { status: "ready", profile: changedProfile, profile_id: sourceIndexProfileId(changedProfile, fieldContractSha256) });
  await expect(executeOrdinaryRecallEntry({ config: f.config, root: changedOutput, queries: [query] })).rejects.toThrow(/Memory embedding profile/u);
  expect(() => admitOrdinaryFrozenExecution({ ...frozen, executionRoot: changedRoot })).toThrow(/Memory embedding profile/u);
}, 60_000);

it("admits an unmapped ordinary archive without inventing a Memory receipt", () => {
  const f = replayFixture(), output = join(f.root, "ordinary");
  const config = SemanticChainConfigSchema.parse({ ...f.config, authorized_scopes: { mode: "named", scopes: ["project", "global_domain"] } });
  const scope = mapOrdinaryRecallScope(config.authorized_scopes);
  if (scope.status !== "not_run") throw new Error("fixture scope must be unmapped");
  const query = { query_key: f.row.query_key, original_query: f.plan.queries[0]!.original_query };
  const mapping = { status: "not_run", reason: scope.reason, unmapped_dimensions: [...ORDINARY_RECALL_UNMAPPED_DIMENSIONS] };
  const costs = { status: "unavailable", reason: "fixture" };
  writeChainArtifact(join(output, "ordinary-entry.json"), { contract: ORDINARY_RECALL_ENTRY_CONTRACT,
    input_identity: chainIdentity({ contract: ORDINARY_RECALL_ENTRY_CONTRACT, config, mapping, queries: [query] }),
    config_identity: chainIdentity(config), mapping, consumer_model_calls: 0, rows: [{ ...query, status: "not_run", reason: scope.reason,
      snapshot_identity: null, pages: [], page_count: 0, stop_cause: "not_run", first_exposure: null, source_intervals: [],
      unobserved_counters: [], costs: { work_units: costs, read_bytes: costs, latency_ms: costs } }] });
  expect(admitOrdinaryFrozenExecution({ executionRoot: f.root, config, query })).toMatchObject({ pages: [], previews: [] });
  expect(existsSync(join(output, "memory-embedding-readiness.json"))).toBe(false);
}, 60_000);
