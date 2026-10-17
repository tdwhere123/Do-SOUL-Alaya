import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { RuntimeGardenComputeConfigSchema, UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import { closeCachedDatabase, initDatabase, SqliteConfigRepo } from "@do-soul/alaya-storage";
import { deriveAddressableSpanViews } from "@do-soul/alaya-core";
import { SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT,
  type SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { admitRetainedNativeSourceSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/freeze/db-copy.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { declareRecoveryInitialQueryPreparation, freezeNativeRecoveryWindow } from "../../../runs/semantic-chain/recovery-window.js";
import { publishInitialRecoverySemantics, admitInitialQualified } from "../../../runs/semantic-chain/recovery-publication.js";
import { prepareInitialRecoveryCorrespondence, buildRecoveryCorrespondenceWorkset } from "../../../runs/semantic-chain/recovery-correspondence.js";
import { readChainArtifact, SemanticChainPlanSchema } from "../../../runs/semantic-chain/contract.js";
import { readSourceExperiment } from "../../../runs/semantic-chain/source-experiment.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { CLOCK, OBSERVED, MODEL, URL, H_PROFILE, Q_PROFILE, BUDGET, ALLOWANCE, queryRaw, sourceRaw, correspondenceRaw,
  fillProposal, fillSource } from "../../longmemeval/ingestion/native-recovery-provider.test-support.js";
import { setExtractionCredentialFixture } from "../../longmemeval/extraction-fill/fixture.js";

const roots: string[] = [];
const CLI = fileURLToPath(new globalThis.URL("../../../../dist/runs/semantic-chain/launch.js", import.meta.url));
const BOOTSTRAP = new globalThis.URL("./source-feedback-experiment-cli.test-support.mjs", import.meta.url).href;
const QUESTION = "Which tool did Mira use for indexing on August 14, 2026?";
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await settleActiveBenchDaemonTasks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });

/** Explicit fixture startup mirrors the guarded constructor contract, not provider defaults. */
async function prepareFeedbackSourceSnapshot(root: string, native: string) {
  const dataDirRoot = join(root, "retained-daemon"), filename = join(dataDirRoot, "alaya.db");
  const daemon = await startBenchDaemon({ dataDirRoot, workspaceId: "feedback-workspace", runId: "source-capture",
    embeddingMode: "disabled", embeddingStartupProbe: "omit", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    for (const [index, source_id] of ["a", "z"].entries()) {
      const content_bytes = `Mira used Cedar for indexing on 2026-${index === 0 ? "08" : "09"}-14.\n`;
      await daemon.importSourceRecord({ source_id, source_version: "1", content_bytes, event_time: OBSERVED,
        recorded_at: new Date(Date.parse("2026-09-21T09:00:00.000Z") + index * 1000).toISOString(), speaker: "assistant",
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, valid_from: null, valid_to: null, scope_class: "project",
        spans: deriveAddressableSpanViews(content_bytes) });
    }
    await daemon.checkpointFieldProjection();
  } finally { await daemon.shutdown(); }
  const retainedPath = join(root, "retained.sqlite");
  checkpointAndCopyBenchDb(filename, retainedPath);
  await admitRetainedNativeSourceSnapshot({ retainedPath, expectedSha256: hashRegularFileNoFollow(retainedPath),
    snapshotPath: native, workspaceId: "feedback-workspace", runId: "feedback-workspace", producerCommit: "0".repeat(40) });
}

/** Reuse authored endpoint assessments, but encode only the request's scoped wire. */
function scopedCorrespondenceRaw(prompt: string) {
  const request = JSON.parse(prompt) as SourceSemanticCorrespondenceRequest, raw = correspondenceRaw(prompt);
  if (request.contract !== SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT) return raw;
  if (request.demand === undefined) throw new Error("authored scoped correspondence has no demand");
  const full = JSON.parse(raw) as { semantic_correspondence: { assessments: { query: string }[] } };
  return JSON.stringify({ decision: "assess", assessments: full.semantic_correspondence.assessments
    .filter(row => request.demand!.demanded_handles.includes(row.query)) });
}

/** All producer output below is authored fixture evidence, never a provider/model execution. */
async function fixture(missingSeed = false) {
  const root = mkdtempSync(join(tmpdir(), "source-feedback-experiment-")); roots.push(root);
  const recovery = join(root, "recovery"), native = join(root, "native.sqlite"), cache = join(root, "c-cache");
  const directory = join(root, "retained-daemon"); mkdirSync(directory);
  const filename = join(directory, "alaya.db"), database = initDatabase({ filename });
  try { new SqliteConfigRepo(database).setParsed("runtime:garden-compute", { config_version: 1,
    provider_kind: "host_worker", model_id: null, provider_url: null, secret_ref: null, enabled: false }, RuntimeGardenComputeConfigSchema); }
  finally { database.close(); closeCachedDatabase(filename); }
  for (const [key, value] of Object.entries({ ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false", ALAYA_EMBEDDING_PROVIDER: "local_onnx",
    ALAYA_SQLITE_WRITE_QUEUE: "0", ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "false", ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS: "30000",
    ALAYA_CONFLICT_LLM_PROVIDER_URL: "", ALAYA_CONFLICT_LLM_MODEL: "" })) vi.stubEnv(key, value);
  await prepareFeedbackSourceSnapshot(root, native);
  const qPath = join(root, "query.json"), qCache = join(root, "q-cache"), hCache = join(root, "h-cache");
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query", model: MODEL,
    provider_url: URL, request_profile: Q_PROFILE, items: [{ original_query: QUESTION }] });
  writeFileSync(qPath, JSON.stringify(workset));
  const feedback = { execution_version: "source-feedback-experiment-v1", budget: { ...BUDGET,
    work_units: BUDGET.work_units * 6, memory_bytes: BUDGET.memory_bytes * 6 }, action_budget: BUDGET, timeout_ms: 30_000 };
  const frozen = { native_snapshot_path: native, population: "originals", source_model: MODEL, source_request_profile: H_PROFILE,
    source_cache_root: hCache, recorded_at: CLOCK, producer_commit: "0".repeat(40), allowance: ALLOWANCE, feedback,
    chain: { implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: CLOCK,
      workspace_id: "feedback-workspace", run_id: "feedback-workspace", query_workset: workset, query_cache_root: qCache,
      correspondence_cache_root: cache, correspondence_generation: { model: MODEL, request_profile: H_PROFILE,
        provider_url: URL, max_output_tokens: 16_384 }, max_output_tokens: 16_384, discovery_page_cap: 1,
      correspondence_pair_cap: 1, correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 1 },
      correspondence_cap: 1, access_policy: "query-conditioned-v1", budget: BUDGET,
      authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1_000_000 } };
  declareRecoveryInitialQueryPreparation(frozen, recovery);
  await fillProposal(qPath, qCache, () => queryRaw(true, false), Q_PROFILE);
  const window = await freezeNativeRecoveryWindow(frozen, recovery);
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL); vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", H_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", URL); setExtractionCredentialFixture();
  const preflight = await fillSource(root, native, hCache, EXTRACTION_OPEN_SEMANTICS_GENERATION, window.selected_missing_keys,
    "source", prompt => sourceRaw(prompt, true));
  vi.unstubAllGlobals();
  await publishInitialRecoverySemantics({ root: recovery, sourcePreflightPath: preflight, sourceCacheRoot: hCache });
  prepareInitialRecoveryCorrespondence(recovery);
  if (!missingSeed) {
    const { settled } = admitInitialQualified(recovery);
    const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(window.initial_chain_root, "prepare.json"))), query = plan.queries[0]!;
    if (query.status !== "ready") throw new Error("authored admitted query required");
    // Author both local C entries once. The initial consumer still has exactly one
    // selected seed; fresh discovery may read the other exact key, never fill it.
    const all = buildRecoveryCorrespondenceWorkset(query, settled.descriptor_export, frozen.chain.correspondence_generation,
      { correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 1 }, correspondence_cap: 2 });
    if (all === null) throw new Error("authored feedback correspondence workset required");
    const allPath = join(root, "authored-correspondences.json"); writeFileSync(allPath, JSON.stringify(all));
    const retained = await fillProposal(allPath, cache, scopedCorrespondenceRaw, H_PROFILE);
    expect(retained.interpreted, JSON.stringify(retained)).toBe(all.items.length);
  }
  return { root, recovery, cache };
}

function child(root: string, fault?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)));
  if (fault !== undefined) env.SOURCE_FEEDBACK_FIXTURE_FAULT = fault;
  env.SOURCE_FEEDBACK_FIXTURE_READONLY_CACHES = JSON.stringify(["c-cache", "q-cache", "h-cache"].map(name => join(root, "..", name)));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const invocation = fault === "caller_abort" ? [fileURLToPath(BOOTSTRAP), root] : [CLI, "recover-reason-initial", "--root", root];
    const process = spawn(globalThis.process.execPath, ["--import", BOOTSTRAP, ...invocation],
      { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    let stdout = "", stderr = "";
    process.stdout.on("data", chunk => { stdout += chunk; }); process.stderr.on("data", chunk => { stderr += chunk; });
    process.on("error", reject); process.on("close", code => {
      const evidence = globalThis.process.env.SOURCE_FEEDBACK_TEST_EVIDENCE_ROOT;
      if (evidence !== undefined) {
        mkdirSync(evidence, { recursive: true });
        const prefix = join(evidence, `${process.pid}-${fault ?? "default"}`);
        writeFileSync(`${prefix}.stdout.json`, stdout); writeFileSync(`${prefix}.stderr.log`, stderr);
      }
      resolve({ code, stdout, stderr });
    });
  });
}
function effectCount(root: string) {
  const database = new DatabaseSync(join(root, "recovery-allowance.sqlite"), { readOnly: true });
  try { return database.prepare("SELECT COUNT(*) AS count FROM effects WHERE name='initial-reason-daemon'").get()!.count; }
  finally { database.close(); }
}

function allowanceState(root: string) {
  const database = new DatabaseSync(join(root, "recovery-allowance.sqlite"), { readOnly: true });
  try { return database.prepare("SELECT work_reserved, memory_reserved, read_count, effect_count FROM cycle").get(); }
  finally { database.close(); }
}
function cacheDigest(root: string): string {
  const hash = createHash("sha256");
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      hash.update(entry.name); const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path); else hash.update(readFileSync(path));
    }
  }
  visit(root); return hash.digest("hex");
}

it("keeps newly managed garden and conflict credentials absent while unrelated secret reads still fail", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)));
  const host = "host-must-not-be-read";
  env.ALAYA_OFFICIAL_GARDEN_SECRET_REF = host;
  env.ALAYA_GARDEN_OPENAI_SECRET_REF = host;
  env.ALAYA_CONFLICT_LLM_API_KEY = host;
  env.ALAYA_CONFLICT_LLM_SECRET_REF = host;
  const probe = spawnSync(process.execPath, ["--import", BOOTSTRAP, "-e",
    `const keys = ["ALAYA_OFFICIAL_GARDEN_SECRET_REF", "ALAYA_GARDEN_OPENAI_SECRET_REF", "ALAYA_CONFLICT_LLM_API_KEY", "ALAYA_CONFLICT_LLM_SECRET_REF"];
     const absent = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
     let unrelated = "missing-throw";
     try { void process.env.ALAYA_UNRELATED_HOST_SECRET; unrelated = "leaked"; }
     catch (error) { unrelated = error instanceof Error ? error.message : String(error); }
     process.stdout.write(JSON.stringify({ absent, unrelated }));`],
    { env, encoding: "utf8", timeout: 10_000 });
  expect(probe.error, probe.stderr).toBeUndefined();
  const payload = JSON.parse(probe.stdout);
  expect(payload.absent).toEqual({
    ALAYA_OFFICIAL_GARDEN_SECRET_REF: null, ALAYA_GARDEN_OPENAI_SECRET_REF: null,
    ALAYA_CONFLICT_LLM_API_KEY: null, ALAYA_CONFLICT_LLM_SECRET_REF: null
  });
  expect(payload.unrelated).toBe("Credential environment access forbidden");
  expect(probe.status).toBe(1);
});

it("runs the compiled existing entry through real Core/daemon/cache and repairs missing projection without a worker", async () => {
  const { recovery, cache } = await fixture();
  const cacheBefore = cacheDigest(cache);
  const failed = await child(recovery, "projection"); expect(failed.code, `${failed.stderr}\n${failed.stdout.slice(-8192)}`).toBe(2);
  const retained = readSourceExperiment(recovery); expect(retained.status).toBe("result_ready");
  expect(retained.execution?.trace.exposures.map(row => row.result.kind)).toEqual(["prepare_source", "validate_source", "reason", "prepare_query", "reason"]);
  expect(retained.execution?.trace.qualification).toMatchObject({ status: "local" });
  expect(retained.execution?.trace.preparations?.[0]).toMatchObject({ status: "ready", new_dispatches: 0 });
  const bytes = readFileSync(join(recovery, "source-experiment-result.json")), allowanceBefore = allowanceState(recovery);
  const repair = await child(recovery, "forbid_start"); expect(repair.code, repair.stderr).toBe(0);
  expect(JSON.parse(repair.stdout).status).toBe("complete"); expect(effectCount(recovery)).toBe(1);
  expect(readFileSync(join(recovery, "source-experiment-result.json"))).toEqual(bytes);
  expect(allowanceState(recovery)).toEqual(allowanceBefore); expect(cacheDigest(cache)).toBe(cacheBefore);
  const reason = readChainArtifact(join(recovery, "initial-reason.json")) as { results: { source_interpretation_id: string }[] };
  expect(reason.results).toHaveLength(1); expect(reason.results[0]!.source_interpretation_id).toBe(retained.input?.session.seed.source_interpretation_id);
}, 120_000);

it("blocks an absent admitted seed before any operation reservation or daemon startup", async () => {
  const { recovery } = await fixture(true);
  const result = await child(recovery, "forbid_start"); expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "blocked", reason: "missing_admitted_seed" });
  expect(effectCount(recovery)).toBe(0); expect(existsSync(join(recovery, "initial-reason.json"))).toBe(false);
}, 120_000);

it("refuses an actual SQLite writer lock without claiming unknown execution or consuming the daemon fence", async () => {
  const { recovery } = await fixture();
  const lock = new DatabaseSync(join(recovery, "recovery-allowance.sqlite"));
  lock.exec("BEGIN IMMEDIATE");
  try {
    const blocked = await child(recovery, "forbid_start");
    expect(blocked.code, `${blocked.stderr}\n${blocked.stdout}`).toBe(2);
    expect(blocked.stderr).toMatch(/database is locked|SQLITE_BUSY/u);
    expect(effectCount(recovery)).toBe(0);
    expect(readSourceExperiment(recovery).status).toBe("not_started");
    expect(existsSync(join(recovery, "source-experiment-result.json"))).toBe(false);
  } finally { lock.exec("ROLLBACK"); lock.close(); }
  const available = await child(recovery); expect(available.code, available.stderr).toBe(0);
  expect(JSON.parse(available.stdout).status).toBe("complete"); expect(effectCount(recovery)).toBe(1);
}, 120_000);

it("holds uncertain execution across a second process instead of retrying a consumed reservation", async () => {
  const { recovery } = await fixture();
  const first = await child(recovery, "after_reservation"); expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ status: "unsettled_unknown", lifetime: { status: "failed", phase: "startup" } });
  const allowanceBefore = allowanceState(recovery);
  const second = await child(recovery); expect(second.code, second.stderr).toBe(0);
  expect(JSON.parse(second.stdout).status).toBe("unsettled_unknown"); expect(effectCount(recovery)).toBe(1);
  expect(allowanceState(recovery)).toEqual(allowanceBefore);
  expect(existsSync(join(recovery, "source-experiment-result.json"))).toBe(false);
}, 120_000);

it("durably retains real worker-loss uncertainty without projecting a seed or replaying the operation", async () => {
  const { recovery } = await fixture();
  const first = await child(recovery, "worker_loss"); expect(first.code, first.stderr).toBe(0);
  const state = readSourceExperiment(recovery);
  expect(state).toMatchObject({ status: "complete", execution: { trace: { status: "unknown",
    accounting: { reserved_work: BUDGET.work_units, reserved_memory_bytes: BUDGET.memory_bytes } } } });
  expect(state.execution?.trace.terminal_cause?.kind).toBe("execution_error");
  expect(existsSync(join(recovery, "initial-reason.json"))).toBe(false);
  expect(existsSync(join(recovery, "source-nomination.json"))).toBe(false);
  const bytes = readFileSync(join(recovery, "source-experiment-result.json")), allowanceBefore = allowanceState(recovery);
  const second = await child(recovery, "forbid_start"); expect(second.code, second.stderr).toBe(0);
  expect(readFileSync(join(recovery, "source-experiment-result.json"))).toEqual(bytes);
  expect(allowanceState(recovery)).toEqual(allowanceBefore); expect(effectCount(recovery)).toBe(1);
}, 120_000);

it("retains caller-linked in-flight cancellation through the compiled consumer and existing worker lifecycle", async () => {
  const { recovery } = await fixture();
  const first = await child(recovery, "caller_abort"); expect(first.code, first.stderr).toBe(0);
  const state = readSourceExperiment(recovery);
  expect(state).toMatchObject({ status: "complete", execution: { trace: { status: "unknown",
    terminal_cause: { kind: "caller_abort" }, accounting: { reserved_work: BUDGET.work_units } } } });
  expect(existsSync(join(recovery, "initial-reason.json"))).toBe(false);
  const bytes = readFileSync(join(recovery, "source-experiment-result.json")), allowanceBefore = allowanceState(recovery);
  const second = await child(recovery, "forbid_start"); expect(second.code, second.stderr).toBe(0);
  expect(readFileSync(join(recovery, "source-experiment-result.json"))).toEqual(bytes);
  expect(allowanceState(recovery)).toEqual(allowanceBefore);
}, 120_000);

it("keeps authoritative feedback when session cleanup fails and never reruns it", async () => {
  const { recovery } = await fixture();
  const first = await child(recovery, "cleanup"); expect(first.code, first.stderr).toBe(0);
  const state = JSON.parse(first.stdout); expect(state.status).toBe("complete");
  expect(state.lifetime).toMatchObject({ status: "failed", phase: "cleanup", diagnostic: { code: "FIXTURE_CLEANUP_REFUSAL",
    cause: { message: "authored cleanup cause" } } });
  const bytes = readFileSync(join(recovery, "source-experiment-result.json"));
  const second = await child(recovery, "forbid_start"); expect(second.code, second.stderr).toBe(0);
  expect(readFileSync(join(recovery, "source-experiment-result.json"))).toEqual(bytes); expect(effectCount(recovery)).toBe(1);
}, 120_000);

it("admits at most one competing process to the whole feedback operation", async () => {
  const { recovery } = await fixture();
  const results = await Promise.all([child(recovery), child(recovery)]);
  expect(results.some(row => row.code === 0 && JSON.parse(row.stdout).status === "complete"), JSON.stringify(results)).toBe(true);
  // The loser may observe completion rather than contend. Neither interleaving
  // can produce a second constructor or a second numerical operation admission.
  expect(readFileSync(join(recovery, "fixture-daemon-starts.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  expect(effectCount(recovery)).toBe(1); expect(readSourceExperiment(recovery).status).toBe("complete");
}, 120_000);
