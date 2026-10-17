import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { openReadOnlyDatabase, closeCachedDatabase } from "@do-soul/alaya-storage";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { readChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { readSourceExperiment } from "../../../runs/semantic-chain/source-experiment.js";
import type { SourceAcquisitionExperimentInput } from "../../../runs/semantic-chain/source-acquisition-experiment.js";
import { admitSourceQualifiedSelection } from "../../../runs/semantic-chain/source-qualified-selection-input.js";
import { buildSourceSemanticWorkerPayload } from "../../../../../core-daemon/src/mcp-memory/tool/interpretation-handler.js";
import { createRecallReadWorkerRuntime } from "../../../../../core-daemon/src/runtime/recall-read-worker/runtime.js";
import { runSourceSemanticWorker } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-reasoning.js";
import { issueSemanticLease, readSemanticLease, sourceSemanticRevision } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-leases.js";
import { SourceSemanticReadBudget } from "../../../../../core-daemon/src/runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerClient } from "../../../../../core-daemon/src/runtime/recall/recall-read-worker-client.js";
import { compareResearchSourceQualifiedSelection } from "../../../../../core-daemon/src/runtime/recall/source-semantic-research-acquisition-controls.js";
import { builtWorkerUrl } from "../../../../../core-daemon/src/__tests__/runtime/recall/recall-read-worker-client-fixture.js";
import { withQualifiedJointFixture } from "./source-qualified-joint.test-support.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await settleActiveBenchDaemonTasks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(boundary.violations).toEqual([]);
});
afterAll(() => boundary.restore());
async function fixture(body: Parameters<typeof withQualifiedJointFixture>[1]) {
  for (const [key, value] of Object.entries({ ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false", ALAYA_EMBEDDING_PROVIDER: "local_onnx",
    ALAYA_SQLITE_WRITE_QUEUE: "0", ALAYA_CONFLICT_LLM_PROVIDER_URL: "", ALAYA_CONFLICT_LLM_MODEL: "",
    ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "false" })) vi.stubEnv(key, value);
  const directory = mkdtempSync(join(tmpdir(), "qualified-joint-")); roots.push(directory);
  await withQualifiedJointFixture(directory, body);
}
async function invoke(input: SourceAcquisitionExperimentInput) {
  const path = `${input.root}-caller.json`; writeFileSync(path, JSON.stringify(input));
  return await new Promise<ReturnType<typeof readSourceExperiment>>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./source-acquisition-caller.test-support.mjs", import.meta.url)), path],
      { env: { ...process.env, NODE_OPTIONS: "", ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS: "60000" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => {
      const evidence = process.env.SOURCE_ACQUISITION_TEST_EVIDENCE_PREFIX;
      if (evidence !== undefined) {
        writeFileSync(`${evidence}-joint-${child.pid}.stdout.json`, stdout);
        writeFileSync(`${evidence}-joint-${child.pid}.stderr.log`, stderr);
      }
      if (code !== 0) { reject(new Error(`qualified joint caller ${code}: ${stderr}\n${stdout.slice(-8192)}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`${stdout}\n${stderr}`)); }
    });
  });
}
function selected(state: ReturnType<typeof readSourceExperiment>) {
  if (state.execution === undefined || !("qualified_comparison" in state.execution)) throw new Error(canonicalJson(state));
  const comparison = state.execution.qualified_comparison.comparison;
  if (comparison?.selection === undefined) throw new Error(canonicalJson(state));
  return comparison.selection;
}
function workerInput(input: SourceAcquisitionExperimentInput) {
  const producer = admitSourceQualifiedSelection(input.config, input.qualified_selection!);
  if (producer.status !== "ready") throw new Error("received Q/C required");
  const payload = buildSourceSemanticWorkerPayload({ now: () => input.config.interpretation_clock,
    interpretationClock: input.config.interpretation_clock }, { workspaceId: input.config.workspace_id,
    runId: input.config.run_id, sessionId: "qualified-joint", agentTarget: "bench" }, {
    kind: "recall", accepts_unreviewed_conditional_results: true, original_query: input.original_query,
    query_semantics: producer.query_semantics, semantic_correspondences: producer.semantic_correspondences,
    access_policy: "query-conditioned-v1", budget: input.config.budget, output_byte_limit: input.config.output_byte_limit }, input.config.authorized_scopes);
  return { payload, producer };
}

it("delivers the fixed population's joint originals and exact dependencies through the guarded external entry, withdraws Bridge and reads durable state without rerunning", async () => {
  await fixture(async ({ input, sources }) => {
    const state = await invoke(input), selection = selected(state), joint = selection.joint!;
    expect(state.lifetime.status, canonicalJson(state)).toBe("closed");
    expect(selection.status, selection.reason ?? canonicalJson(selection)).toBe("complete");
    expect(selection.population.nominees).toHaveLength(16); expect(selection.population.snapshot_source_count).toBe(16);
    expect(selection.eligibility.filter(row => row.h === "ready" && row.c === "admitted")).toHaveLength(6);
    expect(selection.eligibility.filter(row => row.h === "missing")).toHaveLength(10);
    expect(selection.arms.evidence_set_coverage).toBeNull(); expect(selection.fork_work.evidence_set_coverage).toBeNull();
    expect(joint).toMatchObject({ status: "complete", witness_delivered: true,
      assessment: { status: "witnessed", world_claim: "unknown", semantic_status: "unreviewed" } });
    const witness = joint.assessment!.witness!, candidate = joint.candidate!, withdrawn = joint.withdrawal!;
    const required = [input.joint_selection!.seed, input.joint_selection!.approval];
    const defaultProofs = selection.arms.default!.artifact.proofs ?? [];
    expect(required.every(local => defaultProofs.some(proof => proof.source_interpretation_id === local.interpretation_id))).toBe(false);
    for (const [i, local] of required.entries()) {
      const source = selection.population.nominees.find(row => row.interpretation?.interpretation_id === local.interpretation_id)!;
      const proof = candidate.artifact.proofs!.find(proof => proof.source_interpretation_id === local.interpretation_id)!;
      const closure = witness.locals[i]!;
      expect(proof.semantic_correspondence_id).toBe(local.semantic_correspondence_id);
      expect(proof.source_record.identity).toBe(source.current.record_id);
      expect(proof.conditional_computation_id).toBe(closure.proof_identity);
      expect(proof.binding_results!.find(binding => binding.binding_id === closure.binding_id)!.explanation_ids).toEqual(closure.explanation_ids);
      for (const observation of closure.observations) expect(proof.evidence_leaves).toContainEqual(observation);
      expect(candidate.artifact.index.entries.find(entry => entry.target.kind === "source_evidence" && entry.target.root_id === source.current.record_id)!.target)
        .toMatchObject({ span: { content_start: 0, content_end: source.body_bytes, retained_extent: "body", content_complete: true } });
      expect(candidate.artifact.results!.some(row => row.content_preview === sources.find(row => row.id === source.current.source_id)!.text)).toBe(true);
    }
    expect(withdrawn).toMatchObject({ leaf: { leaf_kind: "source_interpretation_presence", occurrence: "fBridge" },
      assessment: { status: "unresolved", witness: null }, independent_approval_preserved: true });
    expect(withdrawn.delivery.artifact.proofs!.some(proof => proof.source_interpretation_id === required[0]!.interpretation_id)).toBe(false);
    expect(withdrawn.delivery.artifact.proofs!.some(proof => proof.source_interpretation_id === required[1]!.interpretation_id)).toBe(true);
    for (const page of [candidate, withdrawn.delivery]) {
      expect(JSON.parse(page.serialized)).toEqual(page.artifact);
      expect(page.full_envelope_bytes).toBeLessThanOrEqual(input.config.output_byte_limit);
      expect(page.artifact).not.toHaveProperty("delivery_id"); expect(page.artifact.index).not.toHaveProperty("continuation");
    }
    expect(selection.work).toEqual(joint.work);
    expect(selection.work.logical_work).toBeGreaterThan(selection.common_work.logical_work!);
    expect(selection.work.logical_work).toBeLessThanOrEqual(input.config.budget.work_units);
    expect(selection.work.logical_memory_bytes).toBeLessThanOrEqual(input.config.budget.memory_bytes);
    const guard = readChainArtifact(join(input.root, "source-experiment-guard.json")) as { parent: { attempted_sends: unknown[]; children: unknown[] } };
    expect(guard.parent.attempted_sends).toEqual([]); expect(guard.parent.children).toEqual([]);
    const db = new DatabaseSync(join(input.root, "recovery-allowance.sqlite"), { readOnly: true });
    try { expect(db.prepare("SELECT count(*) AS n FROM effects").get()!.n).toBe(1); } finally { db.close(); }
    rmSync(input.config.snapshot_path); rmSync(input.config.query_cache_root, { recursive: true });
    expect((await invoke(input)).execution).toEqual(state.execution);
  });
}, 120_000);

it("keeps selected missing H or unexecuted locals and stale or wrong selected premises unwitnessed without omitting nominees", async () => {
  await fixture(async ({ input }) => {
    for (const mode of ["missing_h", "missing_local", "stale", "wrong_role"] as const) {
      const altered = structuredClone(input); altered.root = `${input.root}-${mode}`;
      if (mode === "missing_h") { delete altered.qualified_selection!.nominees[0]!.interpretation; delete altered.qualified_selection!.nominees[0]!.correspondence; }
      if (mode === "missing_local") delete altered.qualified_selection!.nominees[0]!.correspondence;
      if (mode === "stale") Object.assign(altered.joint_selection!.seed, { source_target: { ...altered.joint_selection!.seed.source_target, source_version: "stale" } });
      if (mode === "wrong_role") Object.assign(altered.joint_selection!.approval.time, { source_slot: "ingestionTime" });
      const state = await invoke(altered), selection = selected(state);
      expect(state.lifetime.status, canonicalJson(state)).toBe("closed"); expect(selection.population.nominees).toHaveLength(16);
      expect(selection.joint!.witness_delivered).toBe(false); expect(selection.joint!.assessment?.witness).toBeNull();
      if (mode === "missing_h" || mode === "missing_local") expect(selection.joint!.assessment?.reason).toBe("selected_local_not_executed");
    }
  });
}, 180_000);

it("retains native joint results across rollback failure and charges final outer-wire failure without issuing or evicting leases", async () => {
  await fixture(async ({ input }) => {
    const { payload, producer } = workerInput(input), prepare = vi.fn(async () => { throw new Error("query preparation forbidden"); });
    const client = createRecallReadWorkerClient({ databaseFilename: input.config.snapshot_path, workerUrl: builtWorkerUrl,
      workerCount: 1, requestTimeoutMs: 60000, prepareSourceQuery: prepare })!;
    const cleanup = new Error("authored joint rollback failure"), rollback = vi.spyOn(client.readSnapshot, "rollback").mockRejectedValueOnce(cleanup);
    try {
      const comparison = await compareResearchSourceQualifiedSelection(client, payload, producer.population, { timeoutMs: 60000 }, input.joint_selection);
      expect(comparison.outcome).toBe("failed"); expect(comparison.selection?.joint?.status).toBe("complete");
      expect(comparison.failure).toMatchObject({ phase: "cleanup", cause: cleanup }); expect(prepare).not.toHaveBeenCalled();
    } finally { rollback.mockRestore(); await client.close(); }
    const db = openReadOnlyDatabase(input.config.snapshot_path), runtime = createRecallReadWorkerRuntime(db);
    const handles = [], meter = new SourceSemanticReadBudget(input.config.budget);
    try {
      for (let i = 0; i < 32; i++) handles.push(issueSemanticLease(runtime, { kind: "source", workspace_id: payload.workspace_id,
        principal: payload.principal!, as_of: payload.as_of, lifetime_now: payload.lifetime_now, authorized: ["project"],
        expires_at: "2026-09-18T00:05:00.000Z", revision: sourceSemanticRevision(runtime) }, meter));
      const length = SourceSemanticReadBudget.prototype.canonicalJsonLength;
      const wires: { size: number; spent: number; memory: number }[] = [];
      const sizing = vi.spyOn(SourceSemanticReadBudget.prototype, "canonicalJsonLength").mockImplementation(function (this: SourceSemanticReadBudget, value, planner) {
        const size = length.call(this, value, planner);
        if (typeof value === "object" && value !== null && "kind" in value && value.kind === "research_qualified_selection" && "joint" in value) {
          wires.push({ size, spent: this.spentWork, memory: this.spentBytes });
        }
        return size;
      });
      let normal;
      try { normal = runSourceSemanticWorker(runtime, { ...payload, qualified_control: producer.population, joint_control: input.joint_selection }); }
      finally { sizing.mockRestore(); }
      if (normal.kind !== "research_qualified_selection") throw new Error("qualified joint reply required");
      expect(normal.joint?.status).toBe("complete"); expect(wires).toHaveLength(1);
      // Independent of the canonical-size and quote implementations: the actual JSON wire,
      // with only self-accounting fields replaced by their existing upper-bound numeric receipts.
      const upper = { native_work: input.config.budget.work_units, index_work: input.config.budget.work_units,
        native_accounting: "complete", logical_work: input.config.budget.work_units, native_bytes: input.config.budget.memory_bytes,
        logical_memory_bytes: input.config.budget.memory_bytes, rss_bytes: Number.MAX_SAFE_INTEGER };
      expect(wires[0]!.size).toBe(JSON.stringify({ ...normal, work: upper, joint: { ...normal.joint, work: upper } }).length);
      expect(normal.work.logical_work).toBe(wires[0]!.spent + wires[0]!.size);
      expect(normal.work.logical_memory_bytes).toBe(wires[0]!.memory + 2 * wires[0]!.size);
      const transport = vi.spyOn(SourceSemanticReadBudget.prototype, "canonicalJsonLength").mockImplementation(function (this: SourceSemanticReadBudget, value, planner) {
        if (typeof value === "object" && value !== null && "kind" in value && value.kind === "research_qualified_selection"
          && "joint" in value && "status" in value && value.status === "complete") {
          this.charge(this.work + 1, 0, "authored qualified joint outer transport exhaustion");
        }
        return length.call(this, value, planner);
      });
      try {
        const failed = runSourceSemanticWorker(runtime, { ...payload, qualified_control: producer.population, joint_control: input.joint_selection });
        if (failed.kind !== "research_qualified_selection") throw new Error("funded outer failure required");
        expect(failed.status).toBe("failed"); expect(failed.joint?.status).toBe("failed");
        expect(failed.joint?.reason).toContain("authored qualified joint outer transport exhaustion");
        expect(failed.joint?.candidate).toBeNull(); expect(failed.joint?.withdrawal).toBeNull();
        expect(failed.joint?.witness_delivered).toBe(false); expect(failed.arms.default).not.toBeNull();
        expect(failed.work.logical_work).toBeGreaterThan(failed.common_work.logical_work!);
        expect(failed.work.logical_work).toBeLessThanOrEqual(input.config.budget.work_units);
      } finally { transport.mockRestore(); }
      for (const handle of handles) expect(readSemanticLease(runtime, payload, handle, ["project"], "source")).toBeDefined();
    } finally { db.close({ optimize: false }); closeCachedDatabase(input.config.snapshot_path); }
  });
}, 120_000);
