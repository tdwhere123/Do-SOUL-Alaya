import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AlayaError } from "@do-soul/alaya-protocol";
import { assertChainSnapshot, chainIdentity, readChainArtifact, SemanticChainConfigSchema,
  withSemanticChainDaemon, writeChainArtifact } from "./contract.js";
import { freezeRecoveryAllowance, RecoveryAllowanceSchema, reserveRecoveryHostEffect, reserveRecoveryRead } from "./recovery-allowance.js";
import { captureSourceExperimentValue, publishSourceExperimentLifetime, publishSourceExperimentResult,
  readSourceExperiment, SOURCE_EXPERIMENT_ACTION } from "./source-experiment.js";
import { currentBenchScope } from "../../harness/daemon-task.js";
import { canonicalPath, canonicalPathsOverlap } from "../fs/opened-contained-path.js";
import type { compareResearchSourceAcquisitionControls, compareResearchSourceQualifiedSelection } from "../../../../core-daemon/src/runtime/recall/source-semantic-research-acquisition-controls.js";
import { SourceQualifiedSelectionInputSchema, admitSourceQualifiedSelection, qualifiedSelectionInputPaths } from "./source-qualified-selection-input.js";
export type SourceQualifiedAcquisitionComparison = { producer: ReturnType<typeof admitSourceQualifiedSelection>;
  comparison?: Awaited<ReturnType<typeof compareResearchSourceQualifiedSelection>> };

export type SourceAcquisitionComparison = Awaited<ReturnType<typeof compareResearchSourceAcquisitionControls>>;
const Amount = z.number().int().nonnegative().safe();
export const SourceAcquisitionExperimentInputSchema = z.object({
  contract: z.literal("source-acquisition-experiment-v1"), root: z.string().min(1),
  qualified_selection: SourceQualifiedSelectionInputSchema.optional(),
  config: SemanticChainConfigSchema, original_query: z.string().min(1),
  host_admission: RecoveryAllowanceSchema,
  guard_allocation: z.object({ source_inputs: Amount, utf8_bytes: Amount }).strict(),
  timeout_ms: Amount.positive().max(600_000),
  launch: z.object({ candidate: z.string().min(1), executable: z.string().min(1),
    modules: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)) }).strict()
}).strict();
export type SourceAcquisitionExperimentInput = z.infer<typeof SourceAcquisitionExperimentInputSchema>;
const launchModule = new URL("../../../src/runs/semantic-chain/source-acquisition-launch.mjs", import.meta.url).href;
type LaunchOwner = {
  captureAcquisitionLaunchBinding(): SourceAcquisitionExperimentInput["launch"];
  assertAcquisitionLaunchBinding(binding: SourceAcquisitionExperimentInput["launch"]): void;
  acquisitionLaunchPaths(allocation: SourceAcquisitionExperimentInput["guard_allocation"]): { preload: string; launcher: string };
  inspectAcquisitionGuard(policy: { preload: string; inputs: number; bytes: number; unused: boolean }): Promise<unknown>;
  reconcileAcquisitionGuard(parent: unknown, child: unknown, policy: { preload: string; inputs: number; bytes: number; pid: number }): Promise<unknown>;
};
const require = createRequire(import.meta.url);
function launchOwner(): LaunchOwner { return require("../../../src/runs/semantic-chain/source-acquisition-launch.mjs"); }
/** Pure module-byte capture. No index setup, model binding, provider or cache effects. */
export async function captureSourceAcquisitionLaunchBinding() { return (await launchOwner()).captureAcquisitionLaunchBinding(); }

function assertRoot(input: SourceAcquisitionExperimentInput, root: string): void {
  if (input.root !== root || canonicalPath(root) !== root) throw new AlayaError("CONFLICT", "acquisition requires its canonical frozen root");
  for (const path of [input.config.snapshot_path,
    ...(input.config.source_index === undefined ? [] : [input.config.source_index.cache_root, input.config.source_index.preparation_path]),
    input.config.query_cache_root, input.config.correspondence_cache_root,
    ...(input.qualified_selection === undefined ? [] : qualifiedSelectionInputPaths(input.config, input.qualified_selection))]) {
    if (canonicalPathsOverlap(canonicalPath(root), canonicalPath(path))) {
      throw new AlayaError("CONFLICT", "acquisition output overlaps a frozen input or cache");
    }
  }
  if (existsSync(join(root, "recovery-window.json"))) throw new AlayaError("CONFLICT", "acquisition cannot consume a recovery window");
}
function assertPolicy(input: SourceAcquisitionExperimentInput): void {
  if (input.config.access_policy !== "query-conditioned-v1" || (input.qualified_selection === undefined
    ? input.config.source_index === undefined
    : input.config.source_index !== undefined || input.guard_allocation.source_inputs !== 0 || input.guard_allocation.utf8_bytes !== 0 ||
      input.config.source_preview_extents !== undefined)) {
    throw new AlayaError("VALIDATION", "acquisition requires its prepared index or an explicit zero-inference qualified population");
  }
  // The original question stays frozen independently of its producer interpretation.
  const question = z.object({ original_query: z.string() }).safeParse(input.config.query_workset.items[0]);
  if (input.config.query_workset.items.length !== 1 || !question.success || question.data.original_query !== input.original_query) {
    throw new AlayaError("CONFLICT", "acquisition question differs from frozen configuration");
  }
}

/** Second concrete internal experiment consumer. The callable entry only launches an owned process;
 * it cannot execute model preparation in its caller, and unresolved reservations never rerun. */
export async function compareSemanticChainSourceAcquisition(inputValue: SourceAcquisitionExperimentInput, rootInput: string,
  options: Readonly<{ signal?: AbortSignal }> = {}) {
  const input = SourceAcquisitionExperimentInputSchema.parse(structuredClone(inputValue)), root = resolve(rootInput);
  const capturedOptions = { ...options }, identity = chainIdentity(input);
  let prior: ReturnType<typeof readSourceExperiment>;
  try { prior = readSourceExperiment(root); }
  catch (error) {
    return { status: "blocked" as const, phase: "readback" as const, execution_started: false as const,
      identity: undefined, input: undefined, execution: undefined, projection: undefined, lifetime: { status: "unknown" as const },
      diagnostic: captureSourceExperimentValue(error, true) };
  }
  if (Object.keys(capturedOptions).some(key => key !== "signal")) throw new AlayaError("VALIDATION", "unsupported acquisition options");
  if (prior.input !== undefined && prior.identity !== identity) throw new AlayaError("CONFLICT", "source experiment input changed");
  if (prior.status !== "not_started") return prior; // No readiness, hashing, reservation or process effects on readback.
  const blocked = (phase: "admission" | "reservation", error: unknown) => ({ ...prior, status: "blocked" as const,
    phase, execution_started: false as const, diagnostic: captureSourceExperimentValue(error, true) });
  let owner: LaunchOwner;
  try {
    capturedOptions.signal?.throwIfAborted();
    if (process.env.NODE_OPTIONS || process.execArgv.some(arg => /^(?:--import|--loader|--experimental-loader|--require|-r)(?:=|$)/u.test(arg))) {
      throw new AlayaError("CONFLICT", "acquisition rejects ambient application loaders");
    }
    assertPolicy(input); assertRoot(input, root);
    freezeRecoveryAllowance(root, identity, input.host_admission, input.config.snapshot_path);
    reserveRecoveryRead(root, "admit guarded acquisition", input.config.source_index === undefined
      ? qualifiedSelectionInputPaths(input.config, input.qualified_selection!) : [input.config.source_index.preparation_path]);
    assertChainSnapshot(input.config);
    owner = await launchOwner(); owner.assertAcquisitionLaunchBinding(input.launch);
    const timing = await import("../../../../core-daemon/dist/runtime/recall-read-worker/client-config.js");
    if (input.timeout_ms > timing.normalizeRequestTimeoutMs(undefined)) throw new AlayaError("CONFLICT", "worker ceiling is below frozen acquisition timeout");
    writeChainArtifact(join(root, "source-experiment-input.json"), input);
  } catch (error) { return blocked("admission", error); }
  try { reserveRecoveryHostEffect(root, SOURCE_EXPERIMENT_ACTION, identity, false, true); }
  catch (error) { return blocked("reservation", error); }
  // Admission is a finite, no-refund host floor, not measured work or a physical total cap.
  // Native fork quotes remain in the comparison; never fabricate recordRecoveryNativeWork here.
  try {
    const paths = owner.acquisitionLaunchPaths(input.guard_allocation), deadline = Date.now() + input.timeout_ms;
    writeChainArtifact(join(root, "source-experiment-dispatch.json"), { identity, parent_pid: process.pid, deadline });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)));
    delete env.NODE_OPTIONS; delete env.ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP;
    delete env.ALAYA_SOURCE_EMBEDDING_OFFLINE_CHILD;
    Object.assign(env, { ALAYA_SOURCE_EMBEDDING_OFFLINE_ALLOW_GIT: "1",
      ALAYA_SOURCE_EMBEDDING_OFFLINE_GUARD_RECEIPT_DIR: join(root, "guard-receipts"),
      ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS: String(input.timeout_ms) });
    const exit = await runOwnedProcess(input.launch.executable, ["--import", paths.preload, paths.launcher, root, identity, String(deadline)],
      env, identity, deadline, capturedOptions.signal);
    writeChainArtifact(join(root, "source-experiment-launch.json"), { identity, root, launch: input.launch,
      preload: paths.preload, deadline, ...exit });
    if (readChainArtifact(join(root, "source-experiment-lifetime.json")) === undefined) {
      publishSourceExperimentLifetime(root, { identity, status: "failed", phase: "launch", diagnostic: exit });
    }
  } catch (error) {
    publishSourceExperimentLifetime(root, { identity, status: "failed", phase: "launch", diagnostic: captureSourceExperimentValue(error, true) });
  }
  return readSourceExperiment(root);
}

async function runOwnedProcess(executable: string, args: string[], env: NodeJS.ProcessEnv, identity: string,
  deadline: number, signal?: AbortSignal) {
  return await new Promise<{ pid: number | null; code: number | null; signal: NodeJS.Signals | null;
    guarded: unknown; stdout: string; stderr: string; error?: unknown }>((resolveExit, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let guarded: unknown, stdout = "", stderr = "", error: unknown;
    const cancel = () => {
      try {
        if (child.connected) child.send({ kind: "cancel_source_acquisition", reason: captureSourceExperimentValue(signal?.reason, true) },
          cause => { if (cause !== null) error = captureSourceExperimentValue(cause, true); });
      } catch (cause) { error = captureSourceExperimentValue(cause, true); }
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, Math.max(1, deadline - Date.now()) + 15_000);
    child.on("message", message => {
      if (typeof message === "object" && message !== null && "kind" in message && message.kind === "source_acquisition_guarded") {
        if (guarded !== undefined || !("identity" in message) || message.identity !== identity || !("pid" in message) || message.pid !== child.pid) {
          error = "guarded process establishment mismatch"; child.kill("SIGTERM");
        } else { guarded = message; if (signal?.aborted) cancel(); }
      }
    });
    child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
    child.on("error", cause => { error = captureSourceExperimentValue(cause, true); });
    signal?.addEventListener("abort", cancel, { once: true });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      if (child.pid === undefined && error !== undefined) { reject(error); return; }
      resolveExit({ pid: child.pid ?? null, code, signal: exitSignal, guarded: guarded ?? null, stdout, stderr,
        ...(error === undefined ? {} : { error }) });
    });
  });
}

/** Private child phase. Requires actual active guard instance and the owned external entry argv. */
export async function executeGuardedSourceAcquisition(root: string, identity: string,
  invocation: { signal: AbortSignal; deadline: number; active: unknown }) {
  const input = SourceAcquisitionExperimentInputSchema.parse(readChainArtifact(join(root, "source-experiment-input.json")));
  const owner = await launchOwner(), paths = owner.acquisitionLaunchPaths(input.guard_allocation);
  if (process.execArgv.length !== 2 || process.execArgv[0] !== "--import" || process.execArgv[1] !== paths.preload ||
      !process.send || fileURLToPath(new URL(launchModule)) !== process.argv[1] || process.argv[2] !== root || process.argv[3] !== identity ||
      chainIdentity(input) !== identity || input.root !== root) throw new AlayaError("CONFLICT", "acquisition requires its owned guarded launch");
  const active = await owner.inspectAcquisitionGuard({ preload: paths.preload, inputs: input.guard_allocation.source_inputs,
    bytes: input.guard_allocation.utf8_bytes, unused: true });
  const dispatch = readChainArtifact(join(root, "source-experiment-dispatch.json")) as { identity: string; parent_pid: number; deadline: number };
  const state = readSourceExperiment(root);
  if (state.status !== "unsettled_unknown" || dispatch.identity !== identity || dispatch.parent_pid !== process.ppid ||
      dispatch.deadline !== invocation.deadline || existsSync(join(root, "source-experiment-child-admission.json"))) {
    throw new AlayaError("CONFLICT", "acquisition child dispatch is not a fresh owned reservation");
  }
  writeChainArtifact(join(root, "source-experiment-child-admission.json"), { identity, pid: process.pid, parent_pid: process.ppid,
    deadline: invocation.deadline, active });
  let phase: "startup" | "comparison" | "cleanup" = "startup";
  try {
    const comparisonOwner = await import("../../../../core-daemon/dist/runtime/recall/source-semantic-research-acquisition-controls.js");
    const payloadOwner = await import("../../../../core-daemon/dist/mcp-memory/tool/interpretation-handler.js");
    const producer = input.qualified_selection === undefined ? undefined : admitSourceQualifiedSelection(input.config, input.qualified_selection);
    if (producer?.status === "unavailable") {
      publishSourceExperimentResult(root, identity, { qualified_comparison: { producer } });
      writeChainArtifact(join(root, "source-experiment-child.json"), { identity, pid: process.pid, status: "closed", phase: "comparison", active, physical_total: "unknown" });
      return;
    }
    await withSemanticChainDaemon(input.config, root, async daemon => {
      phase = "comparison";
      const signal = AbortSignal.any([invocation.signal, currentBenchScope()!.signal]);
      const payload = payloadOwner.buildSourceSemanticWorkerPayload({ now: () => new Date().toISOString(),
        interpretationClock: input.config.interpretation_clock }, { workspaceId: input.config.workspace_id,
        runId: input.config.run_id, sessionId: identity, agentTarget: "bench" }, {
        kind: "recall", accepts_unreviewed_conditional_results: true, original_query: input.original_query, access_policy: input.config.access_policy,
        budget: input.config.budget, output_byte_limit: input.config.output_byte_limit,
        ...(producer?.status !== "ready" ? {} : { query_semantics: producer.query_semantics,
          semantic_correspondences: producer.semantic_correspondences }),
        ...(input.config.source_preview_extents === undefined ? {} : { source_preview_extents: input.config.source_preview_extents })
      }, input.config.authorized_scopes);
      const remaining = Math.floor(invocation.deadline - Date.now());
      if (remaining <= 0) throw new AlayaError("DEADLINE", "acquisition lifetime exhausted during startup");
      const client = comparisonOwner.researchSourceAcquisitionClient(daemon.runtime);
      if (producer?.status === "ready") {
        const comparison = await comparisonOwner.compareResearchSourceQualifiedSelection(client, payload, producer.population, { signal, timeoutMs: remaining });
        publishSourceExperimentResult(root, identity, { qualified_comparison: { producer, comparison } });
      } else {
        const comparison = await comparisonOwner.compareResearchSourceAcquisitionControls(client, payload, { signal, timeoutMs: remaining });
        publishSourceExperimentResult(root, identity, { comparison });
      } // Before shutdown, guard reconciliation or diagnostic failures.
      phase = "cleanup";
    }, { signal: invocation.signal, embeddingStartupProbe: "omit" });
    writeChainArtifact(join(root, "source-experiment-child.json"), { identity, pid: process.pid, status: "closed", phase,
      active, physical_total: "unknown" });
  } catch (error) {
    if (input.qualified_selection !== undefined && readSourceExperiment(root).execution === undefined) {
      publishSourceExperimentResult(root, identity, { qualified_failure: { phase, diagnostic: captureSourceExperimentValue(error, true),
        population: input.qualified_selection } });
    }
    writeChainArtifact(join(root, "source-experiment-child.json"), { identity, pid: process.pid, status: "failed", phase,
      active, diagnostic: captureSourceExperimentValue(error, true), physical_total: "unknown" });
  }
}

export async function reconcileGuardedSourceAcquisition(root: string, identity: string, evidence: {
  receipts: { parent: unknown; child: unknown }; policy: { preload: string; inputs: number; bytes: number }; failure?: unknown
}) {
  writeChainArtifact(join(root, "source-experiment-guard.json"), { identity, ...captureSourceExperimentValue(evidence.receipts) as object });
  try {
    if (evidence.failure !== undefined) throw evidence.failure;
    const summary = await launchOwner().reconcileAcquisitionGuard(evidence.receipts.parent, evidence.receipts.child,
      { ...evidence.policy, pid: process.pid });
    const child = readChainArtifact(join(root, "source-experiment-child.json")) as { identity: string; status: string; diagnostic?: unknown };
    if (child.identity !== identity || child.status !== "closed") throw new AlayaError("UNAVAILABLE", "acquisition child lifetime failed", { cause: child.diagnostic });
    writeChainArtifact(join(root, "source-experiment-reconciliation.json"), { identity, status: "reconciled", summary });
    publishSourceExperimentLifetime(root, { identity, status: "closed", phase: "reconciliation" });
  } catch (error) {
    publishSourceExperimentLifetime(root, { identity, status: "failed", phase: "reconciliation", diagnostic: captureSourceExperimentValue(error, true) });
  }
}
