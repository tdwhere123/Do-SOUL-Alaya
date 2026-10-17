import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";
import { AlayaError, canonicalJson, SourceIndexConfigurationSchema,
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
import type {
  SourceIndexProducerPassReceipt, SourceIndexProducerPassRemaining
} from "../../../../core-daemon/src/runtime/source-index/source-index-producer.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const CachedLocalSourceExecutionSchema = z.object({
  cache_root: z.string().min(1).refine(isAbsolute, "explicit absolute model cache required"),
  model_id: z.string().min(1)
}).strict();
const IndexBindingSchema = z.object({
  configuration: SourceIndexConfigurationSchema, config_id: z.string(), profile_id: z.string(),
  selection_revision: z.number().int().nonnegative(), generation_id: z.string(),
  source_epoch: z.number().int().nonnegative(), status: z.enum(["ready", "partial", "valid_empty"]),
  enumeration_complete: z.boolean(), target_count: z.number().int().nonnegative(),
  completed_count: z.number().int().nonnegative()
}).strict();
export const SemanticChainSourceIndexBindingSchema = CachedLocalSourceExecutionSchema.extend({
  kind: z.literal("cached_local"), index: IndexBindingSchema,
  preparation_path: z.string().min(1), preparation_identity: Digest
}).strict();
export type SemanticChainSourceIndexBinding = z.infer<typeof SemanticChainSourceIndexBindingSchema>;

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
        cache_root: binding.cache_root, model_id: binding.model_id }) ||
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
export type SemanticChainSourceSetupAllowance = Readonly<{ maxPasses: number } & SourceIndexProducerPassRemaining>;
type SourceIndexPassRemainingBuilder = { [K in typeof SETUP_METER_KEYS[number]]?: number };

type SourceIndexSetupReceipt = SourceIndexProducerPassReceipt | Readonly<{
  status: "not_run"; reason: "setup_pass_exhausted" | "setup_allowance_exhausted";
  binding: { status: "not_run" }; resources: { work: 0; native_bytes: 0; model_inputs: 0; input_bytes: 0 };
  accounting: "lower_bound"; model_execution_work: "unknown"; warmup: "not_separately_measured"; elapsed_ms: 0;
}>;
const SETUP_RESOURCE_ZERO = { work: 0, native_bytes: 0, model_inputs: 0, input_bytes: 0 } as const;
type SourceIndexPreparationBase = {
  execution: z.infer<typeof CachedLocalSourceExecutionSchema>;
  setup: SourceIndexSetupReceipt;
  setup_passes: number;
  setup_resources: { work: number; native_bytes: number; model_inputs: number; input_bytes: number };
};
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
  const config = SemanticChainConfigSchema.parse(value);
  const execution = CachedLocalSourceExecutionSchema.parse(executionValue);
  const allowance = parseSetupAllowance(setupAllowance);
  if (config.source_index !== undefined) throw new AlayaError("CONFLICT", "Source setup requires an unbound input snapshot");
  assertChainSnapshot(config);
  const root = resolve(rootValue);
  for (const input of [config.snapshot_path, config.query_cache_root, config.correspondence_cache_root, execution.cache_root]) {
    if (canonicalPathsOverlap(canonicalPath(root), canonicalPath(input))) {
      throw new AlayaError("CONFLICT", "Source setup output overlaps an input or model cache");
    }
  }
  if (existsSync(root)) throw new AlayaError("CONFLICT", "Source setup requires a fresh execution root");
  return runBenchDaemonOperation(async () => {
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "source-runtime-"));
    let daemon: BenchDaemonHandle | undefined;
    try {
      restoreSnapshotToDataDir({ snapshotDbPath: config.snapshot_path, expectedSha256: config.snapshot_sha256, dataDirRoot: directory });
      daemon = await startBenchDaemon({ dataDirRoot: directory, workspaceId: config.workspace_id, runId: config.run_id,
        embeddingMode: "env", embeddingProviderKind: "local_onnx", cachedLocalEmbedding: execution,
        embeddingStartupProbe: "omit",
        sourceSemanticInterpretationClock: config.interpretation_clock, fieldProjectionAdmissionMode: "explicit_checkpoint" });
      removeDataDirWhenBenchDaemonCancelled(directory);
      const scope = currentBenchScope();
      if (scope === undefined) throw new AlayaError("CANCELLED", "Source setup has no owning scope");
      const live = daemon;
      return await trackBenchBody(scope, async () => {
      if (live.runtime.runSourceIndexPass === undefined) throw new AlayaError("UNAVAILABLE", "Source producer preparation is unwired");
      const before = inspectSemanticChainSourceIndex(join(directory, "alaya.db"), config.workspace_id, config.budget);
      const queryBudget = config.budget;
      const run = await runBoundedSourceIndexPasses(live, allowance);
      refuseBenchWorkAfterCancel();
      const failure = (reason: string) => {
        const report: SourceIndexPreparationFailure["report"] = {
          contract: "semantic-chain-source-preparation-failure-v1", execution, setup: run.setup, reason,
          setup_passes: run.passes, setup_resources: run.resources };
        writeChainArtifact(join(root, "preparation.json"), report);
        return { config: null, report };
      };
      if (queryBudget !== config.budget) throw new AlayaError("CONFLICT", "Source setup must not reset the query budget");
      // No scheduling was started. Refused/incomplete work and native uncertainty cannot authorize a checkpoint.
      const setup = run.setup;
      const binding = setup.binding;
      if (setup.status !== "settled" || binding.status !== "ready") return failure(setup.reason);
      const usable = (observed: ReturnType<typeof inspectSemanticChainSourceIndex>) =>
        observed.complete && observed.index !== null &&
        binding.profile_id === observed.index.profile_id && binding.profile.provider_kind === "local_onnx" &&
        binding.profile.model_id === execution.model_id &&
        canonicalJson(binding.profile) === canonicalJson(observed.index.configuration.profile);
      const candidate = inspectSemanticChainSourceIndex(join(directory, "alaya.db"), config.workspace_id, config.budget);
      if (!usable(candidate)) return failure(candidate.complete ? "source_profile_mismatch" : "source_index_incomplete");
      await live.checkpointFieldProjection();
      const snapshotPath = join(root, "source-index.sqlite");
      checkpointAndCopyBenchDb(join(directory, "alaya.db"), snapshotPath, { keepLiveConnection: true });
      const observed = inspectSemanticChainSourceIndex(snapshotPath, config.workspace_id, config.budget);
      if (!usable(observed)) return failure("sealed_source_index_changed");
      const reuse = before.complete && canonicalJson(before.index) === canonicalJson(observed.index);
      const report: SourceIndexPreparationSuccess["report"] = {
        contract: "semantic-chain-source-preparation-v1", label: "explicit_normal_producer_diagnostic",
        input_snapshot_path: config.snapshot_path, input_snapshot_sha256: config.snapshot_sha256,
        implementation_revision: config.implementation_revision, workspace_id: config.workspace_id,
        execution, setup, setup_passes: run.passes, setup_resources: run.resources,
        index_status: observed.status, index: observed.index,
        inspection: observed.inspection, before_inspection: before.inspection,
        admission: reuse ? "reused_complete" : "prepared_complete",
        snapshot_path: snapshotPath, snapshot_sha256: hashRegularFileNoFollow(snapshotPath) };
      const path = join(root, "preparation.json");
      writeChainArtifact(path, report);
      const prepared = SemanticChainConfigSchema.parse({ ...config, snapshot_path: snapshotPath,
        snapshot_sha256: report.snapshot_sha256, source_index: { ...execution, kind: "cached_local", index: observed.index,
          preparation_path: path, preparation_identity: chainIdentity(report) } });
      assertChainSnapshot(prepared);
      writeChainJson(join(root, "chain-config.json"), prepared);
      await consume?.(prepared, live);
      return { config: prepared, report };
      });
    } finally {
      await daemon?.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

function parseSetupAllowance(value: SemanticChainSourceSetupAllowance | undefined): {
  maxPasses: number; leftover: SourceIndexProducerPassRemaining | undefined;
} {
  if (value === undefined) return { maxPasses: 1, leftover: undefined };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AlayaError("VALIDATION", "invalid Source setup allowance");
  }
  const maxPasses = value.maxPasses;
  if (typeof maxPasses !== "number" || !Number.isSafeInteger(maxPasses) || maxPasses < 0) {
    throw new AlayaError("VALIDATION", "invalid Source setup allowance");
  }
  for (const key of Object.keys(value)) {
    if (key !== "maxPasses" && !(SETUP_METER_KEYS as readonly string[]).includes(key)) {
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
  return { maxPasses, leftover: restricted ? leftover : undefined };
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

function idleSetupReceipt(reason: "setup_pass_exhausted" | "setup_allowance_exhausted"): SourceIndexSetupReceipt {
  return { status: "not_run", reason, binding: { status: "not_run" }, resources: SETUP_RESOURCE_ZERO,
    accounting: "lower_bound", model_execution_work: "unknown", warmup: "not_separately_measured", elapsed_ms: 0 };
}

async function runBoundedSourceIndexPasses(daemon: BenchDaemonHandle, allowance: {
  maxPasses: number; leftover: SourceIndexProducerPassRemaining | undefined;
}): Promise<{ setup: SourceIndexSetupReceipt; passes: number;
  resources: { work: number; native_bytes: number; model_inputs: number; input_bytes: number };
}> {
  const run = daemon.runtime.runSourceIndexPass!;
  let leftover = allowance.leftover === undefined ? undefined : { ...allowance.leftover };
  let last: SourceIndexSetupReceipt | undefined;
  const resources = { ...SETUP_RESOURCE_ZERO };
  let passes = 0;
  for (let index = 0; index < allowance.maxPasses; index++) {
    refuseBenchWorkAfterCancel();
    if (leftover !== undefined && setupMetersExhausted(leftover)) {
      last ??= idleSetupReceipt("setup_allowance_exhausted");
      break;
    }
    const pass = await run(leftover);
    passes += 1;
    resources.work += pass.resources.work;
    resources.native_bytes += pass.resources.native_bytes;
    resources.model_inputs += pass.resources.model_inputs;
    resources.input_bytes += pass.resources.input_bytes;
    last = pass;
    if (leftover !== undefined) leftover = debitSetupLeftover(leftover, pass.resources);
    if (pass.status === "settled" || !canContinueSourceIndexPass(pass.status, pass.reason)) break;
  }
  if (last === undefined) last = idleSetupReceipt("setup_pass_exhausted");
  return { setup: last, passes, resources };
}
