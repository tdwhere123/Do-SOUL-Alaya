import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import { deriveAddressableSpanViews, fieldContractSha256 } from "@do-soul/alaya-core";
import { closeCachedDatabase, initDatabase, SqliteSourceIndexRepository, SqliteFieldSourceRecordRepo, SqliteFieldEraseBarrierRepo } from "@do-soul/alaya-storage";
import { configuration, captureDocuments } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/materialize.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { inspectSemanticChainSourceIndex } from "../../../runs/semantic-chain/source-index-binding.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { readSourceExperiment } from "../../../runs/semantic-chain/source-experiment.js";
import { freezeRecoveryAllowance, reserveRecoveryHostEffect } from "../../../runs/semantic-chain/recovery-allowance.js";
import { captureSourceAcquisitionLaunchBinding, compareSemanticChainSourceAcquisition, executeGuardedSourceAcquisition,
  type SourceAcquisitionExperimentInput } from "../../../runs/semantic-chain/source-acquisition-experiment.js";

const roots: string[] = [];
const childPath = fileURLToPath(new URL("../../../../../../packages/core/dist/embedding-recall/local-onnx-process/child.js", import.meta.url));
const childBytes = readFileSync(childPath);
const QUESTION = "Which tools does Alice use?", BODY = "Alice uses Cedar tools.", CLOCK = "2026-09-21T09:00:00.000Z";
const BUDGET = { schema_version: 1 as const, work_units: 2_000_000, memory_bytes: 64_000_000,
  page_budget: 1_000_000, finalization_reserve: 10000, min_envelope: 10 };
const ALLOWANCE = { total_work_units: 100, total_memory_bytes: 100, read_work_units: 1, read_memory_bytes: 1,
  max_input_bytes_per_read: 32 * 1024 * 1024, max_read_admissions: 16, max_effects: 1 };
beforeAll(() => { writeFileSync(childPath, readFileSync(new URL("./source-acquisition-model-child.test-support.mjs", import.meta.url))); });
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await settleActiveBenchDaemonTasks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => { writeFileSync(childPath, childBytes); expect(boundary.violations).toEqual([]); boundary.restore(); });

async function fixture(options: { unavailable?: boolean; delay_ms?: number; close_exit_code?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "source-acquisition-experiment-")); roots.push(directory);
  const data = join(directory, "authored-source"), cache = join(directory, "synthetic-model-cache"), root = join(directory, "execution");
  mkdirSync(cache);
  for (const [name, value] of Object.entries({ ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false", ALAYA_EMBEDDING_PROVIDER: "local_onnx",
    ALAYA_SQLITE_WRITE_QUEUE: "0", ALAYA_CONFLICT_LLM_PROVIDER_URL: "", ALAYA_CONFLICT_LLM_MODEL: "",
    ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "false" })) vi.stubEnv(name, value);
  const daemon = await startBenchDaemon({ dataDirRoot: data, workspaceId: "acquisition-fixture", runId: "acquisition-run",
    embeddingMode: "disabled", embeddingStartupProbe: "omit", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    await daemon.importSourceRecord({ source_id: "authored-source", source_version: "1", content_bytes: BODY,
      event_time: null, recorded_at: CLOCK, speaker: "user", attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
      valid_from: null, valid_to: null, scope_class: "project", spans: deriveAddressableSpanViews(BODY) });
    await daemon.checkpointFieldProjection();
  } finally { await daemon.shutdown(); }
  const database = initDatabase({ filename: join(data, "alaya.db") });
  const index = new SqliteSourceIndexRepository(database, fieldContractSha256);
  const selection = index.select("acquisition-fixture", configuration({ provider_kind: "local_onnx", model_id: "synthetic-model",
    dimensions: 384, window_bytes: 128, max_input_tokens: 64 }));
  const generation = index.begin(selection);
  const documents = captureDocuments({ database, index, records: new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
    erase: new SqliteFieldEraseBarrierRepo(database, fieldContractSha256) }, generation);
  for (const document of documents) for (const window of document.windows) {
    expect(index.writeVector("acquisition-fixture", generation.generation_id, { window_id: window.window_id,
      input_digest: window.content_digest, embedding: Float32Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0),
      token_count: 2, truncated: false })).toEqual({ status: "accepted" });
  }
  expect(index.activate("acquisition-fixture", generation.generation_id)).toEqual({ status: "accepted" });
  database.close(); closeCachedDatabase(join(data, "alaya.db"));
  const snapshot = join(directory, "prepared.sqlite"); checkpointAndCopyBenchDb(join(data, "alaya.db"), snapshot);
  const observed = inspectSemanticChainSourceIndex(snapshot, "acquisition-fixture", BUDGET);
  expect(observed.complete).toBe(true);
  const preparation = join(directory, "preparation.json"), execution = { cache_root: cache, model_id: "synthetic-model" };
  const report = { contract: "semantic-chain-source-preparation-v1", execution, snapshot_path: snapshot,
    snapshot_sha256: hashRegularFileNoFollow(snapshot), workspace_id: "acquisition-fixture", index: observed.index,
    setup: { status: "settled", binding: { status: "ready", profile_id: selection.profile_id, profile: selection.configuration.profile } } };
  writeChainArtifact(preparation, report);
  writeFileSync(join(cache, "synthetic-profile.json"), JSON.stringify({ profile: selection.configuration.profile, profile_id: selection.profile_id, ...options }));
  const input: SourceAcquisitionExperimentInput = { contract: "source-acquisition-experiment-v1", root, original_query: QUESTION,
    host_admission: ALLOWANCE, guard_allocation: { source_inputs: 1, utf8_bytes: Buffer.byteLength(QUESTION) }, timeout_ms: 30_000,
    launch: await captureSourceAcquisitionLaunchBinding(), config: { snapshot_path: snapshot, snapshot_sha256: report.snapshot_sha256,
      implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: CLOCK, workspace_id: "acquisition-fixture", run_id: "acquisition-run",
      query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query", model: "authored",
        provider_url: "https://invalid.example", request_profile: "authored", items: [{ original_query: QUESTION }] }),
      query_cache_root: join(directory, "unused-query-cache"), correspondence_cache_root: join(directory, "unused-c-cache"),
      max_output_tokens: 100, discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1",
      budget: BUDGET, authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1_000_000,
      source_index: { ...execution, kind: "cached_local", index: observed.index!, preparation_path: preparation, preparation_identity: chainIdentity(report) } } };
  return { directory, cache, root, input };
}
function effects(root: string) {
  const db = new DatabaseSync(join(root, "recovery-allowance.sqlite"), { readOnly: true });
  try { return { effects: db.prepare("SELECT * FROM effects").all(), meters: db.prepare("SELECT * FROM native_observations").all() }; }
  finally { db.close(); }
}
async function invoke(h: Awaited<ReturnType<typeof fixture>>, signal?: AbortSignal) {
  const path = join(h.directory, "caller-input.json"); writeFileSync(path, JSON.stringify(h.input));
  return await new Promise<Awaited<ReturnType<typeof compareSemanticChainSourceAcquisition>>>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./source-acquisition-caller.test-support.mjs", import.meta.url)), path],
      { env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
    const cancel = () => child.send("cancel"); signal?.addEventListener("abort", cancel, { once: true });
    child.on("error", reject); child.on("close", code => {
      signal?.removeEventListener("abort", cancel);
      const evidence = process.env.SOURCE_ACQUISITION_TEST_EVIDENCE_PREFIX;
      if (evidence !== undefined) {
        writeFileSync(`${evidence}-${child.pid}.stdout.json`, stdout);
        writeFileSync(`${evidence}-${child.pid}.stderr.log`, stderr);
      }
      if (code !== 0) { reject(new Error(`synthetic caller exit ${code}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`${String(error)}: ${stdout}; ${stderr}`)); }
    });
  });
}
function comparison(state: Awaited<ReturnType<typeof compareSemanticChainSourceAcquisition>>) {
  if (state.execution === undefined || !("comparison" in state.execution)) throw new Error(JSON.stringify(state));
  return state.execution.comparison;
}

it("launches the exact early guard, prepares physically once, runs three native arms and retains independent costs", async () => {
  const h = await fixture();
  const state = await invoke(h);
  const result = comparison(state);
  expect(result.outcome).toBe("complete"); expect(state.lifetime.status, JSON.stringify(state.lifetime)).toBe("closed");
  expect(result.physical_prepare_once.submitted_inputs).toBe(1);
  for (const control of ["lexical", "vector", "dual"] as const) {
    const arm = result.arm_envelopes[control]; expect(arm.kind).toBe("PRIVATE_COUNTERFACTUAL");
    if (arm.kind !== "PRIVATE_COUNTERFACTUAL") throw new Error("arm missing");
    expect(arm.request_budget).toEqual(BUDGET); expect(arm.control).toBe(control);
    expect(arm.artifact).not.toHaveProperty("private_delivery"); expect(arm.full_envelope_bytes).toBeGreaterThan(0);
    const lexical = arm.private_delivery.lexical_prefix!;
    expect(lexical).toBeDefined();
    if (control === "vector") {
      expect(lexical).toMatchObject({ status: "not_run", reason: "lexical_channel_not_requested", evidence: null, candidate: null });
    } else {
      expect(lexical.status).toBe("complete");
      expect(lexical.evidence!.reader.tokenization!.terms).toContain("tools");
      expect(lexical.evidence!.reader_limit).toBe(128);
      expect(lexical.control!.package_repertoire).toEqual(lexical.candidate!.package_repertoire);
      expect(lexical.candidate!.artifact.results![0]!.content_preview).toBe(BODY);
      expect(lexical.evidence!.resources.sql_internal_work).toBe("unknown");
    }
  }
  expect(effects(h.root).effects).toHaveLength(1); expect(effects(h.root).meters).toEqual([]);
  const guard = readChainArtifact(join(h.root, "source-experiment-guard.json")) as { parent: { dispatched_sends: { op: string }[]; children: { exited: boolean }[] } };
  expect(guard.parent.dispatched_sends.filter(row => row.op === "embed_source")).toHaveLength(1);
  expect(guard.parent.children).toMatchObject([{ exited: true }]);
  rmSync(h.input.config.snapshot_path); rmSync(h.cache, { recursive: true });
  const replay = await invoke(h);
  expect(comparison(replay)).toEqual(result); expect(replay.lifetime).toEqual(state.lifetime);
}, 60_000);

it("refuses unguarded direct dispatch before startup and refuses ambient loaders before reservation", async () => {
  const h = await fixture();
  freezeRecoveryAllowance(h.root, chainIdentity(h.input), h.input.host_admission, h.input.config.snapshot_path);
  writeChainArtifact(join(h.root, "source-experiment-input.json"), h.input);
  await expect(executeGuardedSourceAcquisition(h.root, chainIdentity(h.input), { signal: new AbortController().signal,
    deadline: Date.now() + 1000, active: { marker: true } })).rejects.toThrow("owned guarded launch");
  vi.stubEnv("NODE_OPTIONS", "--import=data:text/javascript,throw%20new%20Error()");
  expect(await compareSemanticChainSourceAcquisition(h.input, h.root)).toMatchObject({ status: "blocked", execution_started: false });
  expect(effects(h.root).effects).toEqual([]);
});

it.each(["source_inputs", "utf8_bytes"] as const)("refuses exhausted %s before forwarding and retains unknown/failure evidence", async cap => {
  const h = await fixture(); h.input.guard_allocation[cap] = 0;
  const state = await invoke(h);
  expect(comparison(state).outcome).not.toBe("complete"); expect(state.lifetime.status).toBe("failed");
  const guard = readChainArtifact(join(h.root, "source-experiment-guard.json")) as { parent: { blocked_sends: { op: string }[]; dispatched_sends: { op: string }[] } };
  expect(guard.parent.blocked_sends.some(row => row.op === "embed_source")).toBe(true);
  expect(guard.parent.dispatched_sends.some(row => row.op === "embed_source")).toBe(false);
  expect(effects(h.root).effects).toHaveLength(1);
  expect(comparison(await invoke(h))).toEqual(comparison(state));
}, 60_000);

it("retains an unavailable comparison without pretending a complete result is population success", async () => {
  const h = await fixture({ unavailable: true });
  const state = await invoke(h);
  expect(comparison(state).outcome).toBe("unavailable");
  expect(comparison(state).arm_envelopes.dual.kind).toBe("not_completed");
  expect(state.lifetime.status).toBe("closed");
}, 60_000);

it("holds unresolved occupancy across action names and never starts acquisition from another admission", async () => {
  const h = await fixture();
  freezeRecoveryAllowance(h.root, chainIdentity(h.input), h.input.host_admission, h.input.config.snapshot_path);
  reserveRecoveryHostEffect(h.root, "initial-reason-daemon", "retained-one-shot", false);
  expect(await compareSemanticChainSourceAcquisition(h.input, h.root)).toMatchObject({ status: "unsettled_unknown" });
  expect(existsSync(join(h.root, "source-experiment-input.json"))).toBe(false);
  expect(effects(h.root).effects).toHaveLength(1);
});

it("excludes competing processes and future renamed effects without refund or replay", async () => {
  const h = await fixture(); h.input.host_admission.max_effects = 64;
  const settled = await Promise.allSettled([invoke(h), invoke(h)]);
  expect(settled.filter(row => row.status === "rejected")).toEqual([]);
  const results = settled.flatMap(row => row.status === "fulfilled" ? [row.value] : []);
  expect(results.filter(state => state.execution !== undefined)).toHaveLength(1);
  expect(effects(h.root).effects).toHaveLength(1);
  expect(() => reserveRecoveryHostEffect(h.root, "renamed-daemon", "different", false)).toThrow("already has an effect reservation");
  expect(comparison(await invoke(h)).outcome).toBe("complete");
}, 60_000);

it("does not bypass existing root occupancy under another action name", async () => {
  const h = await fixture(); h.input.host_admission.max_effects = 64;
  freezeRecoveryAllowance(h.root, chainIdentity(h.input), h.input.host_admission, h.input.config.snapshot_path);
  reserveRecoveryHostEffect(h.root, "renamed-prior-daemon", "retained", false);
  expect(await invoke(h)).toMatchObject({ status: "blocked", phase: "reservation", execution_started: false });
  expect(effects(h.root).effects).toHaveLength(1);
  expect(existsSync(join(h.root, "source-experiment-dispatch.json"))).toBe(false);
}, 60_000);

it("retains the actual complete comparison when child shutdown reconciliation fails and reads it without readiness", async () => {
  const h = await fixture({ close_exit_code: 1 });
  const state = await invoke(h);
  expect(comparison(state).outcome).toBe("complete"); expect(state.lifetime.status).toBe("failed");
  rmSync(h.input.config.snapshot_path); rmSync(h.cache, { recursive: true });
  expect((await invoke(h)).execution).toEqual(state.execution);
  expect(effects(h.root).effects).toHaveLength(1);
}, 60_000);

it("links caller cancellation through preparation and preserves held execution and shutdown evidence", async () => {
  const h = await fixture({ delay_ms: 2000 }), caller = new AbortController();
  const pending = invoke(h, caller.signal);
  const started = Date.now();
  while (!existsSync(join(h.cache, "synthetic-dispatch.jsonl")) || !readFileSync(join(h.cache, "synthetic-dispatch.jsonl"), "utf8").includes("embed_source")) {
    if (Date.now() - started > 15_000) throw new Error("synthetic IPC did not reach guarded preparation");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  caller.abort({ authored: "caller-cancel" });
  const state = await pending;
  expect(comparison(state).outcome).not.toBe("complete");
  expect(effects(h.root).effects).toHaveLength(1);
  expect(readSourceExperiment(h.root).execution).toEqual(state.execution);
}, 60_000);
