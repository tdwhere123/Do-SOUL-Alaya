import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeMergedLongMemEvalArchive } from "../cli/merge-command-archive.js";
import {
  buildMergedLongMemEvalPayload,
  loadMergeShards
} from "../cli/merge-command-shards.js";
import { loadDatasetWithIdentity } from "./fetch.js";
import type { VerifiedLongMemEvalDatasetAuthority } from "./fetch.js";
import type { LongMemEvalVariant } from "./dataset.js";
import type { LongMemEvalRunOptions, LongMemEvalRunResult } from "./runner.js";
import { finalizeOwnedTempRoot } from "./lifecycle/owned-temp-root.js";
import { throwLifecycleErrors } from "./lifecycle/errors.js";
import { validateShardRunProvenancePlans } from "./provenance/shard-aggregate.js";
import {
  withLongMemEvalDiagnosticsSpool,
  type LongMemEvalDiagnosticsSpool
} from "./diagnostics/spool.js";
import { readOptionalTreatmentBoolean } from "../harness/strict-treatment-config.js";
import { loadQuestionManifestSelection } from "./selection/question-manifest.js";
import { deriveMergedLongMemEvalReleaseAuthority } from
  "../cli/merge/release-evidence-authority.js";

export interface LongMemEvalWorkerShardPlan {
  readonly shardIndex: number;
  readonly offset: number;
  readonly limit: number;
  readonly historyRoot: string;
}

export interface LongMemEvalWorkerSpawnOptions {
  readonly cliPath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly logPath: string;
}

export type LongMemEvalWorkerSpawner = (
  options: LongMemEvalWorkerSpawnOptions
) => Promise<number>;

export interface LongMemEvalConcurrencyDeps {
  readonly spawnWorker?: LongMemEvalWorkerSpawner;
  readonly resolveCliPath?: () => string;
}

interface LongMemEvalConcurrentContext {
  readonly opts: LongMemEvalRunOptions;
  readonly concurrency: number;
  readonly shardRoot: string;
  readonly plans: readonly LongMemEvalWorkerShardPlan[];
  readonly cliPath: string;
  readonly spawnWorker: LongMemEvalWorkerSpawner;
  readonly logDir: string;
  readonly datasetAuthority: VerifiedLongMemEvalDatasetAuthority | null;
}

export function freezeProcessEnvForWorkers(
  env: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return Object.freeze({ ...env, ...overrides });
}

/** Shared ONNX single-flight lock for concurrent env-embedding workers. */
export function buildLongMemEvalWorkerEnvOverrides(input: {
  readonly concurrency: number;
  readonly embeddingMode: LongMemEvalRunOptions["embeddingMode"];
  readonly crossEncoderEnabled?: boolean;
  readonly shardRoot: string;
  readonly historyRoot: string;
}): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = {
    ALAYA_BENCH_ARTIFACT_ROOT: join(input.historyRoot, ".bench-artifacts")
  };
  if (
    input.concurrency > 1 &&
    (input.embeddingMode === "env" || input.crossEncoderEnabled === true)
  ) {
    overrides.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT = "1";
    overrides.ALAYA_LOCAL_ONNX_LOCK_PATH = join(
      input.shardRoot,
      "local-onnx-inference.lock"
    );
  }
  return overrides;
}

export function resolveLongMemEvalConcurrency(opts: LongMemEvalRunOptions): number {
  const raw = opts.concurrency ?? 1;
  return Math.max(1, Math.floor(raw));
}

export function shouldFanOutLongMemEvalWorkers(opts: LongMemEvalRunOptions): boolean {
  return resolveLongMemEvalConcurrency(opts) > 1;
}

export function buildLongMemEvalWorkerShardPlans(input: {
  readonly windowLength: number;
  readonly baseOffset: number;
  readonly concurrency: number;
  readonly shardRoot: string;
}): readonly LongMemEvalWorkerShardPlan[] {
  const concurrency = Math.max(1, Math.floor(input.concurrency));
  const shardSize = Math.ceil(input.windowLength / concurrency);
  const plans: LongMemEvalWorkerShardPlan[] = [];
  for (let shardIndex = 0; shardIndex < concurrency; shardIndex += 1) {
    const relOffset = shardIndex * shardSize;
    if (relOffset >= input.windowLength) break;
    const remain = input.windowLength - relOffset;
    const limit = Math.min(remain, shardSize);
    plans.push({
      shardIndex,
      offset: input.baseOffset + relOffset,
      limit,
      historyRoot: join(input.shardRoot, `shard-${shardIndex}`)
    });
  }
  return plans;
}

export function validateLongMemEvalConcurrency(opts: LongMemEvalRunOptions): void {
  if (!shouldFanOutLongMemEvalWorkers(opts)) return;
  if (opts.qa !== undefined) {
    throw new Error(
      "longmemeval --concurrency > 1 is incompatible with --qa; " +
        "each worker process must own its garden chat clients."
    );
  }
  if (opts.snapshotOut !== undefined) {
    throw new Error(
      "longmemeval --concurrency > 1 is incompatible with --snapshot-out; " +
        "run a single-worker snapshot first, then recall-eval."
    );
  }
  if (opts.dataDirRoot !== undefined) {
    throw new Error(
      "longmemeval --concurrency > 1 is incompatible with --data-dir-root; " +
        "each worker needs an isolated daemon DB."
    );
  }
  if (opts.questionManifest !== undefined) {
    throw new Error(
      "longmemeval --question-manifest is incompatible with --concurrency > 1; " +
        "run the manifest with a single worker."
    );
  }
}

export async function runLongMemEvalConcurrent(
  opts: LongMemEvalRunOptions,
  deps: LongMemEvalConcurrencyDeps = {}
): Promise<LongMemEvalRunResult> {
  validateLongMemEvalConcurrency(opts);
  const context = await prepareLongMemEvalConcurrentRun(opts, deps);
  let succeeded = false;
  let result: LongMemEvalRunResult | undefined;
  let primaryError: unknown;
  try {
    await runLongMemEvalConcurrentWorkers(context);
    result = await mergeLongMemEvalConcurrentRun(context);
    succeeded = true;
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    await finalizeOwnedTempRoot({ path: context.shardRoot, owned: true }, succeeded);
  } catch (error) {
    cleanupError = error;
  }
  throwLifecycleErrors("LongMemEval concurrent lifecycle failed", [
    primaryError,
    cleanupError
  ]);
  if (result === undefined) throw new Error("LongMemEval concurrent run produced no result");
  return result;
}

async function prepareLongMemEvalConcurrentRun(
  opts: LongMemEvalRunOptions,
  deps: LongMemEvalConcurrencyDeps
): Promise<LongMemEvalConcurrentContext> {
  const concurrency = resolveLongMemEvalConcurrency(opts);
  const selection = await loadConcurrentSelection(opts);
  const { baseOffset, windowLength } = selection;
  const shardRoot = await mkdtemp(join(tmpdir(), "alaya-lme-shards-"));
  const plans = buildLongMemEvalWorkerShardPlans({
    windowLength,
    baseOffset,
    concurrency,
    shardRoot
  });
  const cliPath = deps.resolveCliPath?.() ?? resolveDefaultBenchRunnerCliPath();
  const spawnWorker = deps.spawnWorker ?? spawnLongMemEvalWorkerProcess;
  const logDir = join(shardRoot, "logs");
  await mkdir(logDir, { recursive: true });

  process.stdout.write(
    `[longmemeval concurrency] process-backed workers=${plans.length} ` +
      `window=${windowLength} cli=${cliPath}\n`
  );
  return {
    opts, concurrency, shardRoot, plans, cliPath, spawnWorker, logDir,
    datasetAuthority: selection.datasetAuthority
  };
}

async function loadConcurrentSelection(
  opts: LongMemEvalRunOptions
): Promise<{
  readonly baseOffset: number;
  readonly windowLength: number;
  readonly datasetAuthority: VerifiedLongMemEvalDatasetAuthority | null;
}> {
  const dataset = await loadDatasetWithIdentity(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const questions = opts.questionManifest === undefined
    ? dataset.questions
    : await loadQuestionManifestSelection({
        manifestPath: opts.questionManifest,
        questions: dataset.questions,
        variant: opts.variant,
        datasetSha256: dataset.sha256
      });
  const baseOffset = Math.max(0, opts.offset ?? 0);
  const sliceEnd =
    opts.limit !== undefined ? baseOffset + opts.limit : questions.length;
  const windowLength = Math.max(0, Math.min(sliceEnd, questions.length) - baseOffset);
  if (windowLength === 0) {
    throw new Error("longmemeval --concurrency: no questions in the selected window");
  }
  return {
    baseOffset,
    windowLength,
    datasetAuthority: dataset.promotionAuthority
  };
}

async function runLongMemEvalConcurrentWorkers(
  context: LongMemEvalConcurrentContext
): Promise<void> {
  const results = await Promise.all(
    context.plans.map((plan) => runLongMemEvalConcurrentWorker(context, plan))
  );
  if (results.some((result) => result.fatal)) {
    throw new Error(
      `longmemeval --concurrency: one or more worker processes failed (${results.map((result) => result.status).join(",")})`
    );
  }
}

async function runLongMemEvalConcurrentWorker(
  context: LongMemEvalConcurrentContext,
  plan: LongMemEvalWorkerShardPlan
): Promise<{ readonly status: number; readonly fatal: boolean }> {
  const logPath = join(context.logDir, `shard-${plan.shardIndex}.log`);
  const status = await context.spawnWorker({
    cliPath: context.cliPath,
    args: buildWorkerCliArgs(context.opts, plan),
    env: freezeProcessEnvForWorkers(
      process.env,
      buildLongMemEvalWorkerEnvOverrides({
        concurrency: context.concurrency,
        embeddingMode: context.opts.embeddingMode,
        crossEncoderEnabled: readOptionalTreatmentBoolean(
          process.env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK,
          "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
        ) === true,
        shardRoot: context.shardRoot,
        historyRoot: plan.historyRoot
      })
    ),
    logPath
  });
  const mergeable = status === 1 && await shardHasMergeableKpi(plan.historyRoot);
  if (status !== 0) {
    process.stderr.write(mergeable
      ? `[longmemeval concurrency] shard ${plan.shardIndex} exited status=1 after writing KPI; allowing merge log=${logPath}\n`
      : `[longmemeval concurrency] shard ${plan.shardIndex} exited status=${status} log=${logPath}\n`);
  }
  return { status, fatal: status !== 0 && !mergeable };
}

async function mergeLongMemEvalConcurrentRun(
  context: LongMemEvalConcurrentContext
): Promise<LongMemEvalRunResult> {
  return withLongMemEvalDiagnosticsSpool((diagnosticsSpool) =>
    mergeLongMemEvalConcurrentRunWithSpool(context, diagnosticsSpool)
  );
}

async function mergeLongMemEvalConcurrentRunWithSpool(
  context: LongMemEvalConcurrentContext,
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<LongMemEvalRunResult> {
  const shardRoots = context.plans.map((plan) => plan.historyRoot);
  process.stdout.write(
    `[longmemeval concurrency] merging ${shardRoots.length} shard(s) -> ${context.opts.historyRoot}\n`
  );
  const loaded = await loadMergeShards(shardRoots, diagnosticsSpool);
  const build = buildMergedLongMemEvalPayload(loaded);
  await validateShardRunProvenancePlans({
    shardArchiveRefs: loaded.archiveRefs,
    plans: context.plans,
    requestedConcurrency: context.concurrency,
    selectionContract: build.selectionContract
  });
  const archive = await writeMergedLongMemEvalArchive({
    historyRoot: context.opts.historyRoot,
    releaseEvidenceAuthority: deriveMergedLongMemEvalReleaseAuthority(
      context.datasetAuthority,
      loaded.archiveRefs
    ),
    build,
    shardArchiveRefs: loaded.archiveRefs,
    requestedConcurrency: context.concurrency,
    diagnosticsSpool
  });
  return {
    slug: archive.slug,
    kpiPath: archive.kpiPath,
    reportPath: join(dirname(archive.kpiPath), "report.md"),
    findingsPath: join(dirname(archive.kpiPath), "findings.md"),
    diagnosticsPath: archive.diagnosticsPath,
    payload: archive.merged,
    evidenceContext: archive.evidenceContext
  };
}

function resolveDefaultBenchRunnerCliPath(): string {
  const fromEnv = process.env.ALAYA_BENCH_RUNNER_CLI?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  const here = fileURLToPath(import.meta.url);
  return resolve(here, "../../../bin/alaya-bench-runner.mjs");
}

function variantToCliFlag(variant: LongMemEvalVariant): string {
  const map: Record<LongMemEvalVariant, string> = {
    longmemeval_oracle: "oracle",
    longmemeval_s: "s",
    longmemeval_m: "m"
  };
  return map[variant];
}

function buildWorkerCliArgs(
  opts: LongMemEvalRunOptions,
  plan: LongMemEvalWorkerShardPlan
): string[] {
  const args = [
    "longmemeval",
    "--variant",
    variantToCliFlag(opts.variant),
    "--offset",
    String(plan.offset),
    "--limit",
    String(plan.limit),
    "--embedding",
    opts.embeddingMode ?? "disabled",
    "--policy-shape",
    opts.policyShape ?? "stress",
    "--simulate-report",
    opts.simulateReport ?? "none",
    "--history-root",
    plan.historyRoot
  ];
  if (opts.embeddingProviderKind !== undefined) {
    args.push("--embedding-provider", opts.embeddingProviderKind);
  }
  if (opts.weightOverridesJson !== undefined) {
    args.push("--weights", opts.weightOverridesJson);
  }
  if (opts.dataDir !== undefined) {
    args.push("--data-dir", opts.dataDir);
  }
  if (opts.pinnedMetaRoot !== undefined) {
    args.push("--pinned-meta-root", opts.pinnedMetaRoot);
  }
  if (opts.extractionCacheRoot !== undefined) {
    args.push("--extraction-cache-root", opts.extractionCacheRoot);
  }
  return args;
}

async function spawnLongMemEvalWorkerProcess(
  options: LongMemEvalWorkerSpawnOptions
): Promise<number> {
  const { open } = await import("node:fs/promises");
  const logHandle = await open(options.logPath, "w");
  try {
    return await new Promise<number>((resolveExit, reject) => {
      const child = spawn(process.execPath, [options.cliPath, ...options.args], {
        env: options.env,
        stdio: ["ignore", logHandle.fd, logHandle.fd]
      });
      child.once("error", reject);
      child.once("close", (code) => resolveExit(code ?? 1));
    });
  } finally {
    await logHandle.close();
  }
}

async function shardHasMergeableKpi(historyRoot: string): Promise<boolean> {
  const publicRoot = join(historyRoot, "public");
  try {
    const entries = await readdir(publicRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        await access(join(publicRoot, entry.name, "kpi.json"));
        return true;
      } catch {
        // Keep scanning sibling archives.
      }
    }
  } catch {
    return false;
  }
  return false;
}
