import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sourceSemanticCorrespondenceIdentity, SourceSemanticResourceLedger, SourceSemanticWorkerWorkSchema } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { z } from "zod";
import { openReadOnlyDatabase, closeCachedDatabase } from "@do-soul/alaya-storage";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { freezeRecoveryAllowance, reserveRecoveryHostEffect } from "../../../runs/semantic-chain/recovery-allowance.js";
import { readSourceExperiment, publishSourceExperimentResult, SOURCE_EXPERIMENT_ACTION } from "../../../runs/semantic-chain/source-experiment.js";
import { SourceAcquisitionExperimentInputSchema, type SourceAcquisitionExperimentInput }
  from "../../../runs/semantic-chain/source-acquisition-experiment.js";
import { admitSourceQualifiedSelection, qualifiedSelectionInputPaths } from "../../../runs/semantic-chain/source-qualified-selection-input.js";
import { semanticProposalShardPath } from "../../../runs/semantic-proposal/artifact.js";
import { materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { prepareRetainedSemanticProposalRevision } from "../../../runs/semantic-proposal/fill.js";
import { qualifiedSelectionFixture, CLOCK, CAPTURE } from "./source-qualified-selection.test-support.js";
import { qualifiedPersonaSuccessor, publishQualifiedPersonaInterpretations, forgePersonaPredecessor } from "./source-qualified-persona.test-support.js";
import { buildSourceSemanticWorkerPayload } from "../../../../../core-daemon/src/mcp-memory/tool/interpretation-handler.js";
import { createRecallReadWorkerRuntime } from "../../../../../core-daemon/src/runtime/recall-read-worker/runtime.js";
import { runSourceSemanticWorker } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-reasoning.js";
import { issueSemanticLease, readSemanticLease, sourceSemanticRevision } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-leases.js";
import { SourceSemanticReadBudget } from "../../../../../core-daemon/src/runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerClient } from "../../../../../core-daemon/src/runtime/recall/recall-read-worker-client.js";
import { compareResearchSourceQualifiedSelection } from "../../../../../core-daemon/src/runtime/recall/source-semantic-research-acquisition-controls.js";
import { builtWorkerUrl } from "../../../../../core-daemon/src/__tests__/runtime/recall/recall-read-worker-client-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await settleActiveBenchDaemonTasks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(boundary.violations).toEqual([]);
});
afterAll(() => boundary.restore());
async function fixture() {
  for (const [key, value] of Object.entries({ ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false", ALAYA_EMBEDDING_PROVIDER: "local_onnx",
    ALAYA_SQLITE_WRITE_QUEUE: "0", ALAYA_CONFLICT_LLM_PROVIDER_URL: "", ALAYA_CONFLICT_LLM_MODEL: "",
    ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "false" })) vi.stubEnv(key, value);
  const directory = mkdtempSync(join(tmpdir(), "qualified-selection-")); roots.push(directory);
  return qualifiedSelectionFixture(directory);
}
async function invoke(input: SourceAcquisitionExperimentInput) {
  const path = join(input.root, "..", `caller-${Date.now()}-${Math.random()}.json`); writeFileSync(path, JSON.stringify(input));
  return new Promise<ReturnType<typeof readSourceExperiment>>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./source-acquisition-caller.test-support.mjs", import.meta.url)), path],
      { env: { ...process.env, NODE_OPTIONS: "", ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS: "60000" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => {
      const evidence = process.env.SOURCE_ACQUISITION_TEST_EVIDENCE_PREFIX;
      if (evidence !== undefined) {
        writeFileSync(`${evidence}-qualified-${child.pid}.stdout.json`, stdout);
        writeFileSync(`${evidence}-qualified-${child.pid}.stderr.log`, stderr);
      }
      if (code !== 0) { reject(new Error(`qualified caller ${code}: ${stderr}\n${stdout.slice(-8192)}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`${stdout}\n${stderr}`)); }
    });
  });
}
function result(state: ReturnType<typeof readSourceExperiment>) {
  if (state.execution === undefined || !("qualified_comparison" in state.execution)) throw new Error(canonicalJson(state));
  return state.execution.qualified_comparison;
}

it("canonicalizes an aliased fixture directory while production still rejects an aliased frozen root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qualified-selection-alias-")); roots.push(directory);
  const physical = join(directory, "physical"), alias = join(directory, "alias");
  mkdirSync(physical); symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
  const h = await qualifiedSelectionFixture(join(alias, "fixture"));
  const expected = join(realpathSync(physical), "fixture");
  expect(h.directory).toBe(expected);
  expect(h.input.root).toBe(join(expected, "experiment"));
  const rejected = await invoke({ ...h.input, root: join(alias, "fixture", "experiment") });
  expect(rejected).toMatchObject({ status: "blocked", phase: "admission", execution_started: false,
    lifetime: { status: "not_started" }, diagnostic: { message: "acquisition requires its canonical frozen root" } });
  const state = await invoke(h.input);
  expect(state.lifetime.status, canonicalJson(state)).toBe("closed");
  expect(result(state).comparison?.outcome).toBe("complete");
}, 120_000);

it("runs authored sixteen through the compiled guarded consumer, both native selectors, encoded spans/proofs and immutable recovery", async () => {
  const h = await fixture(), state = await invoke(h.input), qualified = result(state);
  expect(state.lifetime.status, canonicalJson(state)).toBe("closed");
  expect(qualified.producer.status).toBe("ready"); expect(qualified.producer.new_dispatches).toBe(0);
  const selection = qualified.comparison!.selection!;
  expect(qualified.comparison!.outcome, canonicalJson(qualified.comparison)).toBe("complete");
  expect(selection.population.nominees).toHaveLength(16); expect(selection.population.snapshot_source_count).toBe(17);
  expect(selection.population.query_as_of).toBeNull(); expect(h.input.config.interpretation_clock).toBe(CLOCK); expect(CAPTURE > CLOCK).toBe(true);
  expect(selection.eligibility.filter(row => row.h === "ready")).toHaveLength(5);
  expect(selection.eligibility.filter(row => row.h === "missing")).toHaveLength(11);
  expect(selection.eligibility.filter(row => row.c === "admitted")).toHaveLength(5);
  expect(selection.fork_start.work_units).toBeLessThan(h.input.config.budget.work_units);
  expect(selection.physical_total).toBe("unknown");
  expect(selection.work.logical_work).toBeLessThanOrEqual(h.input.config.budget.work_units);
  expect(selection.work.logical_memory_bytes).toBeLessThanOrEqual(h.input.config.budget.memory_bytes);
  for (const [policy, arm] of Object.entries(selection.arms)) {
    expect(arm!.policy).toBe(policy); expect(arm!.artifact.query_semantics_status).toMatchObject({ status: "admitted" });
    expect(arm!.artifact.request_budget).toEqual(h.input.config.budget);
    expect(arm!.serialized).toBe(canonicalJson(arm!.artifact)); expect(arm!.full_envelope_bytes).toBeLessThanOrEqual(h.input.config.output_byte_limit);
    expect(arm!.artifact).not.toHaveProperty("delivery_id"); expect(arm!.artifact.index).not.toHaveProperty("continuation");
    expect(arm!.artifact.proofs!.length).toBeGreaterThan(0);
    expect(arm!.work.logical_work).toBeLessThanOrEqual(h.input.config.budget.work_units);
    expect(arm!.work.logical_memory_bytes).toBeLessThanOrEqual(h.input.config.budget.memory_bytes);
    expect(arm!.work.logical_work).toBeGreaterThan(selection.common_work.logical_work!);
    for (const row of arm!.artifact.results ?? []) {
      expect(row.budget_state.within_budget).toBe(true);
      const source = h.task.sources.find(source => source.body === row.content_preview);
      expect(source).toBeDefined();
    }
    for (const entry of arm!.artifact.index.entries) {
      const target = entry.target;
      if (target.kind !== "source_evidence") throw new Error("source target expected");
      const source = selection.population.nominees.find(source => source.current.record_id === target.root_id)!;
      expect(target.span).toMatchObject({ content_start: 0, content_end: source.body_bytes, retained_extent: "body", content_complete: true });
    }
    for (const proof of arm!.artifact.proofs ?? []) {
      const source = selection.population.nominees.find(source => source.current.record_id === proof.source_record.identity)!;
      expect(proof.source_record.source_version).toBe(source.current.source_version);
      expect(proof.source_record.content_digest).toBe(source.current.content_digest);
      expect(proof.source_interpretation_id).toBe(source.interpretation!.interpretation_id);
      expect(proof.world_claim).toBe("unknown"); expect(proof.semantic_status).toBe("unreviewed");
    }
  }
  const guard = readChainArtifact(join(h.root, "source-experiment-guard.json")) as { parent: { attempted_sends: unknown[]; children: unknown[] } };
  expect(guard.parent.attempted_sends).toEqual([]); expect(guard.parent.children).toEqual([]);
  const db = new DatabaseSync(join(h.root, "recovery-allowance.sqlite"), { readOnly: true });
  try {
    expect(db.prepare("SELECT count(*) AS n FROM effects").get()!.n).toBe(1);
    const files = new Set([h.input.config.snapshot_path, ...qualifiedSelectionInputPaths(h.input.config, h.input.qualified_selection!)]);
    const bytes = [...files].filter(existsSync).map(path => statSync(path)).filter(file => file.isFile()).reduce((sum, file) => sum + file.size, 0);
    expect(db.prepare("SELECT input_bytes FROM read_observations WHERE ordinal=2").get()!.input_bytes).toBe(bytes);
    expect(bytes).toBeGreaterThan(statSync(h.input.config.snapshot_path).size);
  } finally { db.close(); }
  rmSync(h.input.config.snapshot_path); rmSync(h.input.config.query_cache_root, { recursive: true });
  expect((await invoke(h.input)).execution).toEqual(state.execution);
}, 120_000);

it("rejects a sixteen-member claim over a larger native seal instead of silently shrinking full membership", async () => {
  const h = await fixture(); h.input.qualified_selection!.snapshot_source_count = 16;
  const state = await invoke(h.input);
  expect(state.lifetime.status).toBe("failed");
  expect(state.execution).toHaveProperty("qualified_failure");
  expect(canonicalJson(state.execution)).toContain("full source snapshot identity changed");
  expect((await invoke(h.input)).execution).toEqual(state.execution);
}, 120_000);

it("keeps absent C and unpublished H as explicit nominees and private fitting leaves existing native leases intact", async () => {
  const h = await fixture(), input = h.input.qualified_selection!;
  delete input.nominees[0]!.correspondence;
  input.nominees[1]!.interpretation = { ...input.nominees[1]!.interpretation!, interpretation_id: `sha256:${"0".repeat(64)}` };
  delete input.nominees[1]!.correspondence;
  const producer = admitSourceQualifiedSelection(h.input.config, input);
  if (producer.status !== "ready") throw new Error("authored producer unavailable");
  const database = openReadOnlyDatabase(h.input.config.snapshot_path), runtime = createRecallReadWorkerRuntime(database);
  const payload = buildSourceSemanticWorkerPayload({ now: () => CAPTURE, interpretationClock: CLOCK },
    { workspaceId: h.input.config.workspace_id, runId: h.input.config.run_id, sessionId: "authored", agentTarget: "bench" },
    { kind: "recall", accepts_unreviewed_conditional_results: true, original_query: h.input.original_query,
      query_semantics: producer.query_semantics, semantic_correspondences: producer.semantic_correspondences,
      access_policy: "query-conditioned-v1", budget: h.input.config.budget, output_byte_limit: h.input.config.output_byte_limit }, h.input.config.authorized_scopes);
  const meter = new SourceSemanticReadBudget(h.input.config.budget), handles: string[] = [];
  try {
    for (let i = 0; i < 32; i++) handles.push(issueSemanticLease(runtime, { kind: "source", workspace_id: payload.workspace_id,
      principal: payload.principal!, as_of: payload.as_of, lifetime_now: payload.lifetime_now, authorized: ["project"],
      expires_at: "2026-09-25T00:05:00.000Z", revision: sourceSemanticRevision(runtime) }, meter));
    const starts = new Map<SourceSemanticReadBudget, { work_units: number; memory_bytes: number }>();
    const charge = SourceSemanticReadBudget.prototype.charge;
    const observer = vi.spyOn(SourceSemanticReadBudget.prototype, "charge").mockImplementation(
      function (this: SourceSemanticReadBudget, work, bytes, phase) {
        if (phase === "library page root census" && !starts.has(this)) starts.set(this, this.remaining());
        return charge.call(this, work, bytes, phase);
      });
    let selected;
    try { selected = runSourceSemanticWorker(runtime, { ...payload, qualified_control: producer.population }); }
    finally { observer.mockRestore(); }
    if (selected.kind !== "research_qualified_selection") throw new Error("private selection expected");
    expect(selected.status, selected.reason ?? "").toBe("complete"); expect(selected.eligibility).toHaveLength(16);
    const start = { work_units: Math.floor(selected.fork_start.work_units / 2), memory_bytes: Math.floor(selected.fork_start.memory_bytes / 2) };
    expect([...starts.values()]).toEqual([start, start]);
    expect(selected.eligibility[0]).toMatchObject({ h: "ready", c: "not_supplied" });
    expect(selected.eligibility[1]).toMatchObject({ h: "rejected", c: "not_supplied" });
    for (const failure of ["stale_version", "wrong_body"] as const) {
      const altered = structuredClone({ ...payload, qualified_control: producer.population });
      if (failure === "stale_version") altered.qualified_control.nominees[0]!.current.source_version = "stale";
      if (failure === "wrong_body") altered.qualified_control.nominees[0]!.body_bytes++;
      const rejected = runSourceSemanticWorker(runtime, altered);
      if (rejected.kind !== "research_qualified_selection") throw new Error("private failure expected");
      expect(rejected.status).toBe("failed"); expect(rejected.eligibility).toHaveLength(16);
      expect(rejected.arms).toEqual({ default: null, evidence_set_coverage: null });
      expect(rejected.failure?.phase).toBe("preparation");
    }
    expect(() => runSourceSemanticWorker(runtime, { ...payload, qualified_control: producer.population,
      authorized_scopes: { mode: "denied" } })).toThrow("requires admitted scopes");
    const invalidQ = structuredClone({ ...payload, qualified_control: producer.population });
    if (invalidQ.request.kind !== "recall" || invalidQ.request.query_semantics === undefined) throw new Error("Q-present payload required");
    invalidQ.request = { ...invalidQ.request, query_semantics: { ...invalidQ.request.query_semantics,
      original_query_digest: `sha256:${"0".repeat(64)}` } };
    expect(() => runSourceSemanticWorker(runtime, invalidQ)).toThrow("requires admitted Q");
    const invalidC = structuredClone({ ...payload, qualified_control: producer.population });
    if (invalidC.request.kind !== "recall" || invalidC.request.semantic_correspondences === undefined) throw new Error("C-present payload required");
    invalidC.request = { ...invalidC.request, semantic_correspondences: invalidC.request.semantic_correspondences.map((c, index) => index === 0
      ? { ...c, query_semantics_id: `sha256:${"0".repeat(64)}` } : c) };
    const unqualified = runSourceSemanticWorker(runtime, invalidC);
    if (unqualified.kind !== "research_qualified_selection") throw new Error("private C admission expected");
    expect(unqualified.eligibility.filter(row => row.c === "rejected")).toHaveLength(1);
    expect(unqualified.eligibility).toHaveLength(16);
    const canonicalLength = SourceSemanticReadBudget.prototype.canonicalJsonLength;
    const transport = vi.spyOn(SourceSemanticReadBudget.prototype, "canonicalJsonLength").mockImplementation(
      function (this: SourceSemanticReadBudget, value, planner) {
        if (typeof value === "object" && value !== null && "kind" in value && value.kind === "research_qualified_selection"
          && "status" in value && value.status === "complete") this.charge(this.work + 1, 0, "authored final transport exhaustion");
        return canonicalLength.call(this, value, planner);
      });
    try {
      const failed = runSourceSemanticWorker(runtime, { ...payload, qualified_control: producer.population });
      if (failed.kind !== "research_qualified_selection") throw new Error("funded failure expected");
      expect(failed.status).toBe("failed"); expect(failed.failure?.phase).toBe("transport");
      expect(failed.arms).toEqual({ default: null, evidence_set_coverage: null });
      expect(failed.fork_work.default).not.toBeNull(); expect(failed.fork_work.evidence_set_coverage).not.toBeNull();
      expect(failed.work.logical_work).toBeLessThanOrEqual(h.input.config.budget.work_units);
    } finally { transport.mockRestore(); }
    for (const handle of handles) expect(readSemanticLease(runtime, payload, handle, ["project"], "source")).toBeDefined();
  } finally { database.close({ optimize: false }); closeCachedDatabase(h.input.config.snapshot_path); }
}, 120_000);

it("retains the completed native selection and raw cleanup cause when rollback fails without preparing a query", async () => {
  const h = await fixture(), producer = admitSourceQualifiedSelection(h.input.config, h.input.qualified_selection!);
  if (producer.status !== "ready") throw new Error("authored inputs required");
  const payload = buildSourceSemanticWorkerPayload({ now: () => CAPTURE, interpretationClock: CLOCK },
    { workspaceId: h.input.config.workspace_id, runId: h.input.config.run_id, sessionId: "cleanup", agentTarget: "bench" },
    { kind: "recall", accepts_unreviewed_conditional_results: true, original_query: h.input.original_query,
      query_semantics: producer.query_semantics, semantic_correspondences: producer.semantic_correspondences,
      access_policy: "query-conditioned-v1", budget: h.input.config.budget, output_byte_limit: h.input.config.output_byte_limit }, h.input.config.authorized_scopes);
  const prepare = vi.fn(async () => { throw new Error("query preparation forbidden"); });
  const client = createRecallReadWorkerClient({ databaseFilename: h.input.config.snapshot_path, workerUrl: builtWorkerUrl,
    workerCount: 1, requestTimeoutMs: 60000, prepareSourceQuery: prepare })!;
  const cleanup = new Error("authored rollback failure", { cause: new Error("authored SQLite cleanup root cause") });
  const rollback = vi.spyOn(client.readSnapshot, "rollback").mockRejectedValueOnce(cleanup);
  try {
    const compared = await compareResearchSourceQualifiedSelection(client, payload, producer.population, { timeoutMs: 60000 });
    expect(compared.outcome).toBe("failed"); expect(compared.selection?.status).toBe("complete");
    expect(compared.failure).toMatchObject({ phase: "cleanup", cause: cleanup }); expect(prepare).not.toHaveBeenCalled();
    const identity = chainIdentity(h.input);
    freezeRecoveryAllowance(h.root, identity, h.input.host_admission, h.input.config.snapshot_path);
    writeChainArtifact(join(h.root, "source-experiment-input.json"), h.input);
    reserveRecoveryHostEffect(h.root, SOURCE_EXPERIMENT_ACTION, identity, false, true);
    // Focused publication-owner coverage: native work/selection plus actual Error cleanup causes stay failure evidence.
    const earlier = new Error("authored earlier worker transport failure", { cause: new Error("authored worker root cause") });
    publishSourceExperimentResult(h.root, identity, { qualified_failure: { phase: "cleanup", population: h.input.qualified_selection!,
      diagnostic: new Error("context-qualified delivery rejected"), comparison: { ...compared, failure: { ...compared.failure!,
        earlier: { phase: "selection", cause: earlier } } } } });
    const retained = readSourceExperiment(h.root);
    expect(retained.execution).not.toHaveProperty("qualified_comparison");
    expect(retained.execution).toMatchObject({ qualified_failure: { comparison: { outcome: "failed", selection: {
      status: "complete", work: { logical_work: expect.any(Number), logical_memory_bytes: expect.any(Number) } }, failure: {
      phase: "cleanup", cause: { message: cleanup.message, cause: { message: "authored SQLite cleanup root cause" } },
      earlier: { phase: "selection", cause: { message: earlier.message, cause: { message: "authored worker root cause" } } } } } } });
    rmSync(h.input.config.snapshot_path);
    expect(readSourceExperiment(h.root).execution).toEqual(retained.execution);
  } finally { rollback.mockRestore(); await client.close(); }
}, 120_000);

it("preserves unavailable producer semantics without starting native selection or relabeling the population empty", async () => {
  const h = await fixture();
  rmSync(h.input.config.query_cache_root, { recursive: true });
  h.input.qualified_selection!.query.cache_identity = null;
  h.input.qualified_selection!.query.historical_production = { status: "unknown" };
  const state = await invoke(h.input), qualified = result(state);
  expect(state.lifetime.status).toBe("closed"); expect(qualified.producer.status).toBe("unavailable");
  expect(qualified.producer.population.nominees).toHaveLength(16); expect(qualified.comparison).toBeUndefined();
  expect((await invoke(h.input)).execution).toEqual(state.execution);
}, 120_000);

it("admits changed persona versions through real predecessor/successor artifacts and rejects caller or self-hashed lineage lies", async () => {
  const h = await fixture(), lineage = await qualifiedPersonaSuccessor(h), input = h.input.qualified_selection!;
  expect(input.nominees.every(row => row.nominee.source_version !== row.current.source_version && row.nominee.record_id !== row.current.record_id)).toBe(true);
  expect(SourceAcquisitionExperimentInputSchema.safeParse(h.input).success).toBe(true);
  const producer = admitSourceQualifiedSelection(h.input.config, input);
  expect(producer.status).toBe("ready");
  const paths = qualifiedSelectionInputPaths(h.input.config, input);
  expect(paths).toContain(lineage.parentPath); expect(paths).toContain(lineage.successorPath);
  expect(paths.filter(path => /\.sources\.[a-f0-9]{64}\.json$/u.test(path))).toHaveLength(2);
  for (const failure of ["forged_nominee", "foreign_source", "wrong_body", "wrong_parent", "unbound"] as const) {
    const altered = structuredClone(input);
    if (failure === "forged_nominee") altered.nominees[0]!.nominee.source_version = "caller-created-history";
    if (failure === "foreign_source") altered.nominees[0]!.nominee = altered.nominees[1]!.nominee;
    if (failure === "wrong_body") altered.nominees[0]!.body_bytes++;
    if (failure === "wrong_parent") altered.persona_successor!.parent_snapshot_path = lineage.successorPath;
    if (failure === "unbound") delete altered.persona_successor;
    expect(() => admitSourceQualifiedSelection(h.input.config, altered), failure).toThrow(/qualified/);
  }
  const state = await invoke(h.input), selection = result(state).comparison!.selection!;
  expect(state.lifetime.status, canonicalJson(state)).toBe("closed");
  expect(selection.status, selection.reason ?? "").toBe("complete");
  expect(selection.population.nominees).toEqual(producer.population.nominees);
  expect(selection.eligibility.every(row => row.h === "missing" && row.c === "not_supplied")).toBe(true);
  for (const arm of Object.values(selection.arms)) expect(arm!.full_envelope_bytes).toBeLessThanOrEqual(h.input.config.output_byte_limit);
  const forged = forgePersonaPredecessor(lineage.successorPath);
  const lied = structuredClone(input);
  lied.nominees[0]!.nominee = { source_id: forged.source_id, record_id: forged.identity,
    source_version: forged.source_version, content_digest: forged.content_digest };
  expect(() => admitSourceQualifiedSelection(h.input.config, lied)).toThrow("actual parent membership");
  expect((await invoke(h.input)).execution).toEqual(state.execution);
  const parentShard = paths.find(path => path.startsWith(`${lineage.parentPath}.sources.`) && /[a-f0-9]{64}\.json$/u.test(path))!;
  truncateSync(parentShard, h.input.host_admission.max_input_bytes_per_read + 1);
  const oversized = structuredClone(h.input); oversized.root = join(h.directory, "oversized-predecessor");
  const blocked = await invoke(oversized);
  expect(blocked).toMatchObject({ status: "blocked", phase: "admission", execution_started: false });
  expect(canonicalJson(blocked)).toContain("recovery input");
  expect(existsSync(join(oversized.root, "source-experiment-dispatch.json"))).toBe(false);
}, 120_000);

it("delivers published successor H and admitted Q/C proofs for changed persona versions through both guarded selectors and durable readback", async () => {
  const h = await fixture(), lineage = await qualifiedPersonaSuccessor(h), published = await publishQualifiedPersonaInterpretations(h);
  const input = h.input.qualified_selection!, expected = lineage.messages.slice(0, 5), state = await invoke(h.input), qualified = result(state);
  expect(state.lifetime.status, canonicalJson(state)).toBe("closed");
  expect(qualified.producer.status).toBe("ready"); expect(qualified.producer.new_dispatches).toBe(0);
  expect(qualified.producer.provenance.map(row => [row.kind, row.status])).toEqual([
    ["query", "interpreted"], ...Array.from({ length: 5 }, () => ["semantic_correspondence", "interpreted"]) ]);
  expect(qualified.comparison?.outcome, canonicalJson(qualified.comparison)).toBe("complete");
  const selection = qualified.comparison!.selection!;
  expect(selection.population.snapshot_source_count).toBe(17); expect(selection.population.nominees).toHaveLength(16);
  expect(selection.eligibility.filter(row => row.h === "ready" && row.c === "admitted")).toHaveLength(5);
  expect(selection.eligibility.filter(row => row.h === "missing" && row.c === "not_supplied")).toHaveLength(11);
  for (const [i, row] of selection.population.nominees.entries()) {
    expect(row.nominee.record_id).toBe(lineage.messages[i]!.predecessor!.identity);
    expect(row.current.record_id).toBe(lineage.messages[i]!.record.identity);
    expect(row.nominee.record_id).not.toBe(row.current.record_id);
    expect(row.nominee.source_version).not.toBe(row.current.source_version);
    expect(row.nominee.content_digest).toBe(row.current.content_digest);
  }
  for (const arm of Object.values(selection.arms)) {
    expect(arm!.full_envelope_bytes).toBeLessThanOrEqual(h.input.config.output_byte_limit);
    expect(arm!.serialized).toBe(canonicalJson(arm!.artifact));
    const artifact = arm!.artifact, proofs = artifact.proofs!;
    expect(artifact.query_semantics_status).toMatchObject({ status: "admitted" });
    expect(proofs).toHaveLength(5); expect(artifact.index.entries).toHaveLength(5); expect(artifact.slot_qualifiers).toHaveLength(5);
    const qualifiers = artifact.slot_qualifiers!;
    expect(qualifiers.every(row => row.evidence_kind === "semantic_proof")).toBe(true);
    expect(proofs.map(proof => proof.source_record.identity).sort()).toEqual(expected.map(row => row.record.identity).sort());
    expect(artifact.results!.map(row => row.content_preview).sort()).toEqual(h.task.sources.map(row => row.body).sort());
    for (const [i, source] of expected.entries()) {
      const record = source.record, descriptor = published.descriptors[i]!, correspondence = published.correspondences[i]!;
      const proof = proofs.find(proof => proof.source_record.identity === record.identity)!;
      expect(proof.source_record).toEqual(record);
      expect(proof.source_target).toMatchObject({ root_id: record.identity, source_version: record.source_version, content_digest: record.content_digest });
      expect(proof.interpretation).toEqual(descriptor.interpretation);
      expect(proof.interpretation.source).toMatchObject({ source_id: record.source_id, source_version: record.source_version,
        content_digest: record.content_digest, attribution_context: record.attribution_context });
      expect(proof.source_interpretation_id).toBe(descriptor.interpretation_id);
      expect(proof.source_interpretation_id).not.toBe(h.task.sources[i]!.package.proofs[0]!.source_interpretation_id);
      expect(proof.query).toEqual(published.query); expect(proof.semantic_correspondence).toEqual(correspondence);
      expect(proof.query_semantics_id).toBe(correspondence.query_semantics_id);
      expect(proof.semantic_correspondence_id).toBe(sourceSemanticCorrespondenceIdentity(correspondence, fieldContractSha256));
      expect(proof.context).toMatchObject({ source_interpretation_id: descriptor.interpretation_id,
        query_semantics_id: proof.query_semantics_id, semantic_correspondence_id: proof.semantic_correspondence_id });
      expect(proof.consumed_leaves.some(leaf => leaf.leaf_kind.startsWith("semantic_correspondence_"))).toBe(true);
      expect(proof.binding_results!.length).toBeGreaterThan(0);
      expect(proof.world_claim).toBe("unknown"); expect(proof.semantic_status).toBe("unreviewed");
      const entry = artifact.index.entries.find(entry => entry.target.kind === "source_evidence" && entry.target.root_id === record.identity)!;
      expect(entry.target).toMatchObject({ kind: "source_evidence", source_version: record.source_version,
        content_digest: record.content_digest, span: { content_start: 0, content_end: Buffer.byteLength(h.task.sources[i]!.body),
          retained_extent: "body", content_complete: true } });
      expect(qualifiers.find(slot => artifact.index.entries[slot.index] === entry)).toMatchObject({
        evidence_kind: "semantic_proof", source_interpretation_id: descriptor.interpretation_id,
        query_semantics_id: proof.query_semantics_id, semantic_correspondence_id: proof.semantic_correspondence_id,
        conditional_computation_id: proof.conditional_computation_id });
    }
  }
  const guard = readChainArtifact(join(h.root, "source-experiment-guard.json")) as { parent: { attempted_sends: unknown[]; children: unknown[] } };
  expect(guard.parent.attempted_sends).toEqual([]); expect(guard.parent.children).toEqual([]);
  rmSync(h.input.config.snapshot_path); rmSync(h.input.config.query_cache_root, { recursive: true });
  for (const row of input.nominees) if (row.correspondence !== undefined) rmSync(row.correspondence.cache_root, { recursive: true });
  rmSync(dirname(lineage.parentPath), { recursive: true }); rmSync(dirname(lineage.successorPath), { recursive: true });
  expect((await invoke(h.input)).execution).toEqual(state.execution);
}, 120_000);

it.each(["retain", "failure_quote", "failure_wire"] as const)("preserves charged %s exhaustion through the actual native worker error wire", async phase => {
  const h = await fixture(), producer = admitSourceQualifiedSelection(h.input.config, h.input.qualified_selection!);
  if (producer.status !== "ready") throw new Error("authored producer required");
  const payload = buildSourceSemanticWorkerPayload({ now: () => CAPTURE, interpretationClock: CLOCK },
    { workspaceId: h.input.config.workspace_id, runId: h.input.config.run_id, sessionId: phase, agentTarget: "bench" },
    { kind: "recall", accepts_unreviewed_conditional_results: true, original_query: h.input.original_query,
      query_semantics: producer.query_semantics, semantic_correspondences: producer.semantic_correspondences,
      access_policy: "query-conditioned-v1", budget: h.input.config.budget, output_byte_limit: h.input.config.output_byte_limit }, h.input.config.authorized_scopes);
  const retained = new SourceSemanticResourceLedger(h.input.config.budget);
  retained.retain([payload.request, producer.population]);
  payload.request = { ...payload.request, budget: { ...payload.request.budget, work_units: phase === "retain" ? 32
    : phase === "failure_quote" ? retained.spentWork + 1000 : payload.request.budget.work_units } };
  if (phase === "failure_wire") producer.population.nominees[0]!.current.source_version = "stale";
  const client = createRecallReadWorkerClient({ databaseFilename: h.input.config.snapshot_path, workerCount: 1, requestTimeoutMs: 60000,
    workerUrl: phase === "failure_wire" ? new URL("./source-qualified-failure-wire.test-support.mjs", import.meta.url) : builtWorkerUrl })!;
  try {
    const compared = await compareResearchSourceQualifiedSelection(client, payload, producer.population, { timeoutMs: 60000 });
    expect(compared.outcome).toBe("failed"); expect(compared.selection).toBeUndefined();
    const error = compared.failure?.cause;
    if (!(error instanceof Error) || !("details" in error)) throw new Error(canonicalJson(compared));
    const details = z.object({ work: SourceSemanticWorkerWorkSchema, physical_total: z.literal("unknown") }).parse(error.details);
    expect(error.message).toContain(phase === "retain" ? "fixed-population admission" : phase === "failure_wire"
      ? "authored qualified failure wire exhaustion" : "budget exhausted");
    expect(details.work.logical_work).toBeGreaterThan(0);
    expect(details.work.logical_memory_bytes).toBeGreaterThan(0);
    expect(details.work.logical_work).toBeLessThanOrEqual(payload.request.budget.work_units);
    if (phase === "failure_quote") expect(details.work.logical_work).toBeGreaterThan(retained.spentWork);
    if (phase === "failure_wire") expect(details.work.native_work).toBeGreaterThan(0);
    const evidence = process.env.SOURCE_ACQUISITION_TEST_EVIDENCE_PREFIX;
    if (evidence !== undefined) writeFileSync(`${evidence}-${phase}-worker-error.json`, JSON.stringify({ phase,
      name: error.name, message: error.message, details, request_budget: payload.request.budget }));
  } finally { await client.close(); }
}, 120_000);

it.each(["Q", "C", "Q_parent", "C_parent"] as const)("refuses oversized nested %s cache input before producer reads or child execution", async kind => {
  const h = await fixture(), input = h.input.qualified_selection!;
  const c = input.nominees.find(row => row.correspondence !== undefined)!.correspondence!;
  const query = kind.startsWith("Q"), parent = kind.endsWith("parent");
  const root = query ? h.input.config.query_cache_root : c.cache_root;
  const workset = query ? h.input.config.query_workset : c.workset;
  const cap = query ? h.input.config.max_output_tokens : c.max_output_tokens;
  const key = query ? input.query.key : c.artifact.key;
  if (parent) {
    const revision = prepareRetainedSemanticProposalRevision({ workset, parentCacheRoot: root, maxOutputTokens: cap, itemIndex: 0,
      ...(query ? {} : { reviewComments: ["Authored unresolved correspondence review."] }) });
    const item = workset.items[0];
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("authored item required");
    const child = { ...workset, revision_parent_cache_root: root, items: [{ ...item, revision }] };
    if (query) {
      h.input.config.query_workset = child; h.input.config.query_cache_root = join(h.directory, "child-q");
      input.query = { key: materializeSemanticProposalLines(child, cap)[0]!.key, cache_identity: null,
        historical_production: { status: "unknown" } };
    }
    else {
      c.workset = child; c.cache_root = join(h.directory, "child-c");
      c.artifact = { key: materializeSemanticProposalLines(child, cap)[0]!.key, cache_identity: null,
        historical_production: { status: "unknown" } };
    }
  }
  const shard = semanticProposalShardPath(root, key);
  expect(qualifiedSelectionInputPaths(h.input.config, input)).toContain(shard);
  truncateSync(shard, h.input.host_admission.max_input_bytes_per_read + 1);
  const blocked = await invoke(h.input);
  expect(blocked).toMatchObject({ status: "blocked", phase: "admission", execution_started: false });
  expect(canonicalJson(blocked)).toContain("recovery input");
  expect(existsSync(join(h.root, "source-experiment-dispatch.json"))).toBe(false);
  const db = new DatabaseSync(join(h.root, "recovery-allowance.sqlite"), { readOnly: true });
  try { expect(db.prepare("SELECT count(*) AS n FROM effects").get()!.n).toBe(0); } finally { db.close(); }
}, 120_000);

it.each(["Q", "C"] as const)("refuses a %s raw-cache directory symlink before inventory traversal or child execution", async kind => {
  const h = await fixture(), input = h.input.qualified_selection!, c = input.nominees.find(row => row.correspondence !== undefined)!.correspondence!;
  const root = kind === "Q" ? h.input.config.query_cache_root : c.cache_root, key = kind === "Q" ? input.query.key : c.artifact.key;
  const directory = join(root, "provider-raw", key.slice(0, 2)), foreign = join(h.directory, "foreign-raw");
  renameSync(directory, foreign); symlinkSync(foreign, directory, "dir");
  expect(() => qualifiedSelectionInputPaths(h.input.config, input)).toThrow();
  const blocked = await invoke(h.input);
  expect(blocked).toMatchObject({ status: "blocked", phase: "admission", execution_started: false });
  expect(existsSync(join(h.root, "source-experiment-dispatch.json"))).toBe(false);
}, 120_000);

it("rejects malformed fixed membership and nonzero inference allocation before launching the application", async () => {
  const h = await fixture();
  const malformed = structuredClone(h.input); malformed.qualified_selection!.nominees.push(malformed.qualified_selection!.nominees[0]!);
  expect(SourceAcquisitionExperimentInputSchema.safeParse(malformed).success).toBe(false);
  h.input.guard_allocation.source_inputs = 1;
  expect(await invoke(h.input)).toMatchObject({ status: "blocked", execution_started: false });
}, 120_000);
