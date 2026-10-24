import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";
import { AlayaError, canonicalJson,
  sourceIndexConfigurationId, sourceIndexGenerationId, sourceIndexProfileId, sourceIndexGenerationCanServeQueries,
  SourceIndexProfileSchema,
  type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { StorageDatabase, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { startBenchDaemon, type BenchDaemonHandle } from "../../harness/daemon.js";
import { runBenchDaemonOperation, refuseBenchWorkAfterCancel, currentBenchScope,
  trackBenchBody, removeDataDirWhenBenchDaemonCancelled } from "../../harness/daemon-task.js";
import { canonicalPath, canonicalPathsOverlap } from "../fs/opened-contained-path.js";
import { restoreSnapshotToDataDir, checkpointAndCopyBenchDb } from "../snapshot/materialize.js";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";
import { SemanticChainConfigSchema, assertChainSnapshot, chainIdentity, readChainArtifact,
  writeChainArtifact, writeChainJson, type SemanticChainConfig } from "./contract.js";
import { CachedLocalSourceExecutionSchema, IndexBindingSchema } from "./source-index-binding-schema.js";
import { captureSourceIndexProgress, compareSourceIndexProgress, sourceIndexProgressBindingMatches,
  type SourceIndexProgressSnapshot, type SourceIndexProgressComparison } from "./source-index-progress.js";
import type {
  SourceIndexProducerPassReceipt, SourceIndexProducerPassRemaining
} from "../../../../core-daemon/src/runtime/source-index/source-index-producer.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);

/** Metadata alone is diagnostic. With a budget, the query reader owns epoch/active eligibility;
 * this chain additionally requires complete captured coverage, not the product's partial-index mode. */
export function inspectSemanticChainSourceIndex(filename: string, workspace: string, budget?: SourceSemanticResourceBudget) {
  const connection = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
  try {
    const repository = new SqliteSourceIndexRepository(new StorageDatabase(filename, connection), fieldContractSha256);
    return connection.transaction(() => {
      const state = repository.state(workspace);
      const generation = "selection" in state && state.active_generation_id !== null
        ? repository.generation(workspace, state.active_generation_id) : null;
      const query = budget === undefined ? null : repository.readVectorCandidates(workspace, null, 1, budget);
      const inspection = query === null ? null : { state: query.state, resources: query.resources };
      if (!("selection" in state) || state.active_generation_id === null || generation === null ||
          !sourceIndexGenerationCanServeQueries(generation.status)) {
        return { status: state.status, index: null, inspection, complete: false };
      }
      const selection = state.selection, profile = selection.configuration.profile;
      const index = IndexBindingSchema.parse({ configuration: selection.configuration, config_id: selection.config_id,
        profile_id: selection.profile_id, selection_revision: selection.selection_revision,
        generation_id: generation.generation_id, source_epoch: generation.source_epoch, status: generation.status,
        enumeration_complete: generation.enumeration_complete, target_count: generation.target_count,
        completed_count: generation.completed_count });
      const eligible = query?.state;
      const complete = eligible !== undefined && (eligible.status === "ready" || eligible.status === "valid_empty") &&
        eligible.binding.generation_id === generation.generation_id && eligible.binding.source_epoch === generation.source_epoch &&
        eligible.binding.config_id === selection.config_id && eligible.binding.profile_id === selection.profile_id &&
        eligible.binding.selection_revision === selection.selection_revision && eligible.binding.dimensions === profile.dimensions &&
        canonicalJson(generation.selection) === canonicalJson(selection) && generation.status === eligible.status &&
        sourceIndexProfileId(profile, fieldContractSha256) === selection.profile_id &&
        sourceIndexConfigurationId(selection.configuration, fieldContractSha256) === selection.config_id &&
        sourceIndexGenerationId(selection, generation.source_epoch, fieldContractSha256) === generation.generation_id &&
        generation.enumeration_complete && generation.completed_count === generation.target_count &&
        (eligible.status === "valid_empty" ? generation.target_count === 0 : generation.target_count > 0);
      return { status: state.status, index, inspection, complete };
    })();
  } finally { connection.close(); }
}

export function assertSemanticChainSourceIndex(config: SemanticChainConfig, filename = config.snapshot_path): void {
  const binding = config.source_index;
  if (binding === undefined) return;
  const report = readChainArtifact(binding.preparation_path);
  if (report === undefined || chainIdentity(report) !== binding.preparation_identity) {
    throw new AlayaError("CONFLICT", "Source preparation receipt changed");
  }
  const observed = inspectSemanticChainSourceIndex(filename, config.workspace_id, config.budget);
  const retained = z.object({ contract: z.literal("semantic-chain-source-preparation-v1"),
    execution: CachedLocalSourceExecutionSchema, snapshot_path: z.string(), snapshot_sha256: Digest,
    workspace_id: z.string(), index: IndexBindingSchema.nullable(),
    setup: z.object({ status: z.literal("settled"), binding: z.object({ status: z.literal("ready"),
      profile_id: z.string(), profile: SourceIndexProfileSchema }).passthrough() }).passthrough()
  }).passthrough().parse(report);
  if (retained.snapshot_path !== config.snapshot_path || retained.snapshot_sha256 !== config.snapshot_sha256 ||
      retained.workspace_id !== config.workspace_id || canonicalJson(retained.execution) !== canonicalJson({
        cache_root: binding.cache_root, model_id: binding.model_id,
        ...(binding.representation === undefined ? {} : { representation: binding.representation }) }) ||
      canonicalJson(binding.representation ?? null) !== canonicalJson(binding.index.configuration.profile.representation ?? null) ||
      canonicalJson(retained.index) !== canonicalJson(binding.index) || !observed.complete ||
      retained.setup.binding.profile_id !== binding.index.profile_id ||
      canonicalJson(retained.setup.binding.profile) !== canonicalJson(binding.index.configuration.profile) ||
      binding.index.configuration.profile.provider_kind !== "local_onnx" ||
      binding.index.configuration.profile.model_id !== binding.model_id ||
      canonicalJson(observed.index) !== canonicalJson(binding.index)) {
    throw new AlayaError("CONFLICT", "Source execution does not bind the sealed active generation");
  }
}

const SETUP_METER_KEYS = ["work", "nativeBytes", "modelInputs", "inputBytes",
  "maxCapturePages", "maxRootsPerPass"] as const;
export type SemanticChainSourceSetupAllowance = Readonly<{ maxPasses: number; softElapsedMs?: number } & SourceIndexProducerPassRemaining>;
type CapturedAllowance = { maxPasses: number; softElapsedMs?: number; leftover?: SourceIndexProducerPassRemaining };
type SourceIndexPassRemainingBuilder = { [K in typeof SETUP_METER_KEYS[number]]?: number };

type SourceIndexSetupReceipt = SourceIndexProducerPassReceipt | Readonly<{
  status: "not_run"; reason: "setup_pass_exhausted" | "setup_allowance_exhausted" | "setup_soft_deadline";
  binding: { status: "not_run" }; resources: { work: 0; native_bytes: 0; model_inputs: 0; input_bytes: 0 };
  accounting: "lower_bound"; model_execution_work: "unknown"; warmup: "not_separately_measured"; elapsed_ms: 0;
}>;
const SETUP_RESOURCE_ZERO = { work: 0, native_bytes: 0, model_inputs: 0, input_bytes: 0 } as const;
const SETUP_DIAGNOSTIC_ZERO = { snapshots: 0, metadata_transactions: 0, target_rows: 0, pending_reads: 0,
  work: 0, native_bytes: 0, sql_internal_work: "unknown" as const };
type SourceIndexPreparationBase = {
  execution: z.infer<typeof CachedLocalSourceExecutionSchema>;
  setup: SourceIndexSetupReceipt;
  setup_passes: number;
  setup_resources: { work: number; native_bytes: number; model_inputs: number; input_bytes: number };
  setup_diagnostics: typeof SETUP_DIAGNOSTIC_ZERO;
  setup_stop_reason: string;
  setup_allowance: CapturedAllowance;
  setup_history: SourceIndexSetupPass[];
  setup_elapsed_ms: number;
  setup_clock: "monotonic_entry_through_awaited_cleanup_before_publication";
};
type SourceIndexSetupPass = {
  pass: number; receipt: SourceIndexProducerPassReceipt;
  remaining_before: SourceIndexProducerPassRemaining | null; remaining_after: SourceIndexProducerPassRemaining | null;
  effective_limits: SourceIndexProducerPassReceipt["limits"];
  before: SourceIndexProgressSnapshot; after: SourceIndexProgressSnapshot; progress: SourceIndexProgressComparison;
  elapsed_ms: number;
};
type SourceIndexSetupRun = { setup: SourceIndexSetupReceipt; passes: number;
  resources: SourceIndexPreparationBase["setup_resources"]; diagnostics: typeof SETUP_DIAGNOSTIC_ZERO;
  history: SourceIndexSetupPass[]; stop_reason: string };
type SourceIndexPreparationFailure = {
  config: null;
  report: SourceIndexPreparationBase & { contract: "semantic-chain-source-preparation-failure-v1"; reason: string };
};
type SourceIndexPreparationSuccess = {
  config: SemanticChainConfig;
  report: SourceIndexPreparationBase & {
    contract: "semantic-chain-source-preparation-v1";
    label: "explicit_normal_producer_diagnostic";
    input_snapshot_path: string;
    input_snapshot_sha256: string;
    implementation_revision: string;
    workspace_id: string;
    index_status: ReturnType<typeof inspectSemanticChainSourceIndex>["status"];
    index: ReturnType<typeof inspectSemanticChainSourceIndex>["index"];
    inspection: ReturnType<typeof inspectSemanticChainSourceIndex>["inspection"];
    before_inspection: ReturnType<typeof inspectSemanticChainSourceIndex>["inspection"];
    admission: "reused_complete" | "prepared_complete";
    snapshot_path: string;
    snapshot_sha256: string;
  };
};

/** Explicit diagnostic setup using the normal producer, not a benchmark index implementation.
 * Default/omitted setup allowance is one constructor-capped pass. An explicit allowance may repeat
 * runSourceIndexPass in-call on the same daemon/producer/DB. Failed/partial setup is retained without
 * an enabled config. The optional live consumer shares the same client; it cannot change the sealed snapshot.
 */
export async function prepareSemanticChainSourceIndex(value: unknown, executionValue: unknown, rootValue: string,
  consume?: (config: SemanticChainConfig, daemon: BenchDaemonHandle) => Promise<void>,
  setupAllowance?: SemanticChainSourceSetupAllowance
): Promise<SourceIndexPreparationFailure | SourceIndexPreparationSuccess> {
  // Capture the mutable caller allocation synchronously, before any await or native startup.
  const allowance = parseSetupAllowance(setupAllowance);
  const started = performance.now();
  const expired = () => allowance.softElapsedMs !== undefined && performance.now() - started >= allowance.softElapsedMs;
  const config = SemanticChainConfigSchema.parse(value);
  const execution = CachedLocalSourceExecutionSchema.parse(executionValue);
  if (config.source_index !== undefined) throw new AlayaError("CONFLICT", "Source setup requires an unbound input snapshot");
  assertChainSnapshot(config);
  const root = resolve(rootValue);
  for (const input of [config.snapshot_path, config.query_cache_root, config.correspondence_cache_root, execution.cache_root]) {
    if (canonicalPathsOverlap(canonicalPath(root), canonicalPath(input))) {
      throw new AlayaError("CONFLICT", "Source setup output overlaps an input or model cache");
    }
  }
  if (existsSync(root)) throw new AlayaError("CONFLICT", "Source setup requires a fresh execution root");
  let owningSignal: AbortSignal | undefined;
  const result = await runBenchDaemonOperation<SourceIndexPreparationFailure | SourceIndexPreparationSuccess>(async () => {
    mkdirSync(root, { recursive: true });
    if (expired()) return retainedSoftDeadline(execution, idleDeadlineRun(), allowance, performance.now() - started);
    const directory = mkdtempSync(join(root, "source-runtime-"));
    let daemon: BenchDaemonHandle | undefined;
    try {
      restoreSnapshotToDataDir({ snapshotDbPath: config.snapshot_path, expectedSha256: config.snapshot_sha256, dataDirRoot: directory });
      if (expired()) return retainedSoftDeadline(execution, idleDeadlineRun(), allowance, performance.now() - started);
      daemon = await startBenchDaemon({ dataDirRoot: directory, workspaceId: config.workspace_id, runId: config.run_id,
        embeddingMode: "env", embeddingProviderKind: "local_onnx", cachedLocalEmbedding: execution,
        embeddingStartupProbe: "omit",
        sourceSemanticInterpretationClock: config.interpretation_clock, fieldProjectionAdmissionMode: "explicit_checkpoint" });
      removeDataDirWhenBenchDaemonCancelled(directory);
      const scope = currentBenchScope();
      if (scope === undefined) throw new AlayaError("CANCELLED", "Source setup has no owning scope");
      owningSignal = scope.signal;
      const live = daemon;
      return await trackBenchBody(scope, () => prepareLiveSourceIndex({ live, config, execution, allowance,
        filename: join(directory, "alaya.db"), root, expired, started, consume }));
    } finally {
      await daemon?.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  refuseBenchWorkAfterCancel();
  if (owningSignal?.aborted) throw new AlayaError("CANCELLED", "Source setup was cancelled before publication");
  if (expired()) {
    const report = retainedSoftDeadline(execution, setupRunFrom(result.report), allowance, performance.now() - started).report;
    writeChainArtifact(join(root, "preparation.json"), report);
    return { config: null, report };
  }
  result.report.setup_elapsed_ms = performance.now() - started;
  writeChainArtifact(join(root, "preparation.json"), result.report);
  if (result.config === null) return result;
  const prepared = bindPreparation(config, execution, result.report, join(root, "preparation.json"));
  assertChainSnapshot(prepared);
  refuseBenchWorkAfterCancel();
  // Publication is synchronous; a frozen success receipt is not rewritten if the clock expires here.
  if (expired()) return retainedSoftDeadline(execution, setupRunFrom(result.report), allowance, performance.now() - started);
  writeChainJson(join(root, "chain-config.json"), prepared);
  return { config: prepared, report: result.report };
}

async function prepareLiveSourceIndex(input: {
  live: BenchDaemonHandle; config: SemanticChainConfig; execution: z.infer<typeof CachedLocalSourceExecutionSchema>;
  allowance: CapturedAllowance; filename: string; root: string; expired: () => boolean; started: number;
  consume?: (config: SemanticChainConfig, daemon: BenchDaemonHandle) => Promise<void>;
}): Promise<SourceIndexPreparationFailure | SourceIndexPreparationSuccess> {
  const { live, config, execution, allowance, filename, root, expired, started, consume } = input;
  if (live.runtime.runSourceIndexPass === undefined) throw new AlayaError("UNAVAILABLE", "Source producer preparation is unwired");
  const before = inspectSemanticChainSourceIndex(filename, config.workspace_id, config.budget);
  const run = await runBoundedSourceIndexPasses(live, allowance, filename, config.workspace_id, root, expired, execution.representation);
  refuseBenchWorkAfterCancel();
  const failure = (reason: string): SourceIndexPreparationFailure => ({ config: null, report: {
    contract: "semantic-chain-source-preparation-failure-v1", execution, reason,
    ...setupReport(run, allowance, performance.now() - started) } });
  // No scheduling was started. Refused/incomplete work and native uncertainty cannot authorize a checkpoint.
  const setup = run.setup, binding = setup.binding;
  if (expired()) return failure("setup_soft_deadline");
  if (setup.status !== "settled" || binding.status !== "ready") return failure(setup.reason);
  if (run.stop_reason !== "settled") return failure(run.stop_reason);
  const usable = (observed: ReturnType<typeof inspectSemanticChainSourceIndex>) =>
    observed.complete && observed.index !== null && binding.profile_id === observed.index.profile_id &&
    binding.profile.provider_kind === "local_onnx" && binding.profile.model_id === execution.model_id &&
    canonicalJson(binding.profile.representation ?? null) === canonicalJson(execution.representation ?? null) &&
    canonicalJson(binding.profile) === canonicalJson(observed.index.configuration.profile);
  const candidate = inspectSemanticChainSourceIndex(filename, config.workspace_id, config.budget);
  if (!usable(candidate)) return failure(candidate.complete ? "source_profile_mismatch" : "source_index_incomplete");
  if (expired()) return failure("setup_soft_deadline");
  await live.checkpointFieldProjection();
  refuseBenchWorkAfterCancel();
  if (expired()) return failure("setup_soft_deadline");
  const snapshotPath = join(root, "source-index.sqlite");
  checkpointAndCopyBenchDb(filename, snapshotPath, { keepLiveConnection: true });
  const observed = inspectSemanticChainSourceIndex(snapshotPath, config.workspace_id, config.budget);
  if (!usable(observed)) return failure("sealed_source_index_changed");
  if (expired()) return failure("setup_soft_deadline");
  const reuse = before.complete && canonicalJson(before.index) === canonicalJson(observed.index);
  const report: SourceIndexPreparationSuccess["report"] = {
    contract: "semantic-chain-source-preparation-v1", label: "explicit_normal_producer_diagnostic",
    input_snapshot_path: config.snapshot_path, input_snapshot_sha256: config.snapshot_sha256,
    implementation_revision: config.implementation_revision, workspace_id: config.workspace_id,
    execution, ...setupReport(run, allowance, performance.now() - started), index_status: observed.status, index: observed.index,
    inspection: observed.inspection, before_inspection: before.inspection, admission: reuse ? "reused_complete" : "prepared_complete",
    snapshot_path: snapshotPath, snapshot_sha256: hashRegularFileNoFollow(snapshotPath) };
  // The optional live consumer gets a separate provisional receipt. External publication follows cleanup.
  if (consume !== undefined) {
    const path = join(root, "live-preparation.json"), provisional = { ...report, preparation_state: "live_before_cleanup" };
    writeChainArtifact(path, provisional);
    const liveConfig = bindPreparation(config, execution, provisional, path);
    assertChainSnapshot(liveConfig);
    await consume(liveConfig, live);
    refuseBenchWorkAfterCancel();
  }
  return { config: bindPreparation(config, execution, report, join(root, "preparation.json")), report };
}

function bindPreparation(config: SemanticChainConfig, execution: z.infer<typeof CachedLocalSourceExecutionSchema>,
  report: SourceIndexPreparationSuccess["report"] | (SourceIndexPreparationSuccess["report"] & { preparation_state: string }), path: string) {
  return SemanticChainConfigSchema.parse({ ...config, snapshot_path: report.snapshot_path,
    snapshot_sha256: report.snapshot_sha256, source_index: { ...execution, kind: "cached_local", index: report.index,
      preparation_path: path, preparation_identity: chainIdentity(report) } });
}

function setupReport(run: SourceIndexSetupRun, allowance: CapturedAllowance, elapsed: number): Omit<SourceIndexPreparationBase, "execution"> {
  return { setup: run.setup, setup_passes: run.passes, setup_resources: run.resources, setup_diagnostics: run.diagnostics,
    setup_history: run.history,
    setup_stop_reason: run.stop_reason, setup_allowance: allowance, setup_elapsed_ms: elapsed,
    setup_clock: "monotonic_entry_through_awaited_cleanup_before_publication" };
}

function setupRunFrom(report: SourceIndexPreparationBase): Omit<SourceIndexSetupRun, "stop_reason"> {
  return { setup: report.setup, passes: report.setup_passes, resources: report.setup_resources,
    diagnostics: report.setup_diagnostics, history: report.setup_history };
}

function idleDeadlineRun(): Omit<SourceIndexSetupRun, "stop_reason"> {
  return { setup: idleSetupReceipt("setup_soft_deadline"), passes: 0, resources: { ...SETUP_RESOURCE_ZERO },
    diagnostics: { ...SETUP_DIAGNOSTIC_ZERO }, history: [] };
}

function retainedSoftDeadline(
  execution: z.infer<typeof CachedLocalSourceExecutionSchema>,
  run: Omit<SourceIndexSetupRun, "stop_reason">,
  allowance: CapturedAllowance,
  elapsed: number
): SourceIndexPreparationFailure {
  return { config: null, report: { contract: "semantic-chain-source-preparation-failure-v1", execution,
    reason: "setup_soft_deadline", ...setupReport({ ...run, stop_reason: "setup_soft_deadline" }, allowance, elapsed) } };
}

function parseSetupAllowance(value: SemanticChainSourceSetupAllowance | undefined): CapturedAllowance {
  if (value === undefined) return { maxPasses: 1 };
  value = structuredClone(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AlayaError("VALIDATION", "invalid Source setup allowance");
  }
  const maxPasses = value.maxPasses;
  if (typeof maxPasses !== "number" || !Number.isSafeInteger(maxPasses) || maxPasses < 0) {
    throw new AlayaError("VALIDATION", "invalid Source setup allowance");
  }
  for (const key of Object.keys(value)) {
    if (key !== "maxPasses" && key !== "softElapsedMs" && !(SETUP_METER_KEYS as readonly string[]).includes(key)) {
      throw new AlayaError("VALIDATION", "invalid Source setup allowance");
    }
  }
  const leftover: SourceIndexPassRemainingBuilder = {};
  let restricted = false;
  for (const key of SETUP_METER_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const meter = value[key];
    if (typeof meter !== "number" || !Number.isSafeInteger(meter) || meter < 0) {
      throw new AlayaError("VALIDATION", "invalid Source setup allowance");
    }
    leftover[key] = meter;
    restricted = true;
  }
  const softElapsedMs = value.softElapsedMs;
  if (Object.hasOwn(value, "softElapsedMs") && (typeof softElapsedMs !== "number" ||
      !Number.isSafeInteger(softElapsedMs) || softElapsedMs < 0)) {
    throw new AlayaError("VALIDATION", "invalid Source setup soft elapsed allowance");
  }
  return { maxPasses, ...(restricted ? { leftover } : {}), ...(softElapsedMs === undefined ? {} : { softElapsedMs }) };
}

function setupMetersExhausted(leftover: SourceIndexProducerPassRemaining): boolean {
  return (leftover.work === 0 || leftover.nativeBytes === 0 || leftover.modelInputs === 0 || leftover.inputBytes === 0);
}

function canContinueSourceIndexPass(status: string, reason: string): boolean {
  if (status === "resource_exhausted") return true;
  return status === "partial" && (reason === "pending_targets" || reason === "capture_incomplete");
}

function debitSetupLeftover(leftover: SourceIndexProducerPassRemaining, spent: {
  work: number; native_bytes: number; model_inputs: number; input_bytes: number;
}): SourceIndexProducerPassRemaining {
  const next: SourceIndexPassRemainingBuilder = { ...leftover };
  if (next.work !== undefined) next.work = Math.max(0, next.work - spent.work);
  if (next.nativeBytes !== undefined) next.nativeBytes = Math.max(0, next.nativeBytes - spent.native_bytes);
  if (next.modelInputs !== undefined) next.modelInputs = Math.max(0, next.modelInputs - spent.model_inputs);
  if (next.inputBytes !== undefined) next.inputBytes = Math.max(0, next.inputBytes - spent.input_bytes);
  return next;
}

function idleSetupReceipt(reason: "setup_pass_exhausted" | "setup_allowance_exhausted" | "setup_soft_deadline"): SourceIndexSetupReceipt {
  return { status: "not_run", reason, binding: { status: "not_run" }, resources: SETUP_RESOURCE_ZERO,
    accounting: "lower_bound", model_execution_work: "unknown", warmup: "not_separately_measured", elapsed_ms: 0 };
}

async function runBoundedSourceIndexPasses(daemon: BenchDaemonHandle, allowance: CapturedAllowance,
  filename: string, workspace: string, root: string, expired: () => boolean,
  representation?: import("@do-soul/alaya-protocol").SourceEmbeddingRepresentation): Promise<SourceIndexSetupRun> {
  const run = daemon.runtime.runSourceIndexPass!;
  let leftover = allowance.leftover === undefined ? undefined : { ...allowance.leftover };
  let last: SourceIndexSetupReceipt | undefined;
  const resources = { ...SETUP_RESOURCE_ZERO }, history: SourceIndexSetupPass[] = [], diagnostics = { ...SETUP_DIAGNOSTIC_ZERO };
  const observe = (pass: number, phase: "before" | "after") => {
    const snapshot = captureSourceIndexProgress(filename, workspace, currentBenchScope()?.signal);
    diagnostics.snapshots++;
    diagnostics.metadata_transactions += snapshot.cost.metadata_transactions;
    diagnostics.target_rows += snapshot.cost.target_rows;
    diagnostics.pending_reads += snapshot.cost.pending_reads;
    diagnostics.work += snapshot.cost.work;
    diagnostics.native_bytes += snapshot.cost.native_bytes;
    // Retain even a diagnostic followed by a deadline/throw before the native pass starts.
    writeChainArtifact(join(root, "diagnostics", `${phase}-${pass}.json`), snapshot);
    return snapshot;
  };
  let stop_reason = "setup_pass_exhausted";
  try {
    for (let index = 0; index < allowance.maxPasses; index++) {
      refuseBenchWorkAfterCancel();
      if (expired()) { stop_reason = "setup_soft_deadline"; break; }
      if (leftover !== undefined && setupMetersExhausted(leftover)) { stop_reason = "setup_allowance_exhausted"; break; }
      const started = performance.now(), remaining = leftover === undefined ? undefined : { ...leftover };
      const before = observe(index + 1, "before");
      if (expired()) { stop_reason = "setup_soft_deadline"; break; }
      // The retained capture is never passed to a collaborator that could mutate it.
      const pass = structuredClone(await run(remaining === undefined ? undefined : { ...remaining }, representation));
      last = pass;
      resources.work += pass.resources.work;
      resources.native_bytes += pass.resources.native_bytes;
      resources.model_inputs += pass.resources.model_inputs;
      resources.input_bytes += pass.resources.input_bytes;
      const exceeded = remaining !== undefined && (pass.resources.work > (remaining.work ?? Infinity) ||
        pass.resources.native_bytes > (remaining.nativeBytes ?? Infinity) ||
        pass.resources.model_inputs > (remaining.modelInputs ?? Infinity) || pass.resources.input_bytes > (remaining.inputBytes ?? Infinity));
      if (leftover !== undefined) leftover = debitSetupLeftover(leftover, pass.resources);
      const after = observe(index + 1, "after"), progress = compareSourceIndexProgress(before, after);
      const effective = { ...pass.limits };
      for (const key of SETUP_METER_KEYS) if (remaining?.[key] !== undefined) effective[key] = Math.min(effective[key], remaining[key]!);
      const entry: SourceIndexSetupPass = { pass: index + 1, receipt: pass,
        remaining_before: remaining ?? null, remaining_after: leftover === undefined ? null : { ...leftover },
        effective_limits: effective, before, after, progress, elapsed_ms: performance.now() - started };
      history.push(entry);
      // Keep every completed native receipt and its meters before another pass or cancellation check.
      writeChainArtifact(join(root, "passes", `pass-${index + 1}.json`), entry);
      refuseBenchWorkAfterCancel();
      if (expired()) { stop_reason = "setup_soft_deadline"; break; }
      if (exceeded) { stop_reason = "setup_accounting_exceeded"; break; }
      if (pass.binding.status !== "ready" || !sourceIndexProgressBindingMatches(after, pass.binding)) {
        stop_reason = "source_binding_invalid"; break;
      }
      if (pass.status === "settled") { stop_reason = "settled"; break; }
      if (!canContinueSourceIndexPass(pass.status, pass.reason)) { stop_reason = "native_terminal"; break; }
      if (progress.status === "no_progress") { stop_reason = "setup_no_progress"; break; }
      if (leftover !== undefined && setupMetersExhausted(leftover)) { stop_reason = "setup_allowance_exhausted"; break; }
    }
  } catch (error) {
    writeChainArtifact(join(root, "setup-failure-prefix.json"), { setup: last ?? null, history, resources, diagnostics,
      stop_reason: "threw", failure: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
    throw error;
  }
  last ??= idleSetupReceipt(stop_reason === "setup_soft_deadline" || stop_reason === "setup_allowance_exhausted"
    ? stop_reason : "setup_pass_exhausted");
  return { setup: last, passes: history.length, resources, history, diagnostics, stop_reason };
}
