import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeMergedLongMemEvalArchive } from "../../../cli/merge/command/merge-command-archive.js";
import {
  buildMergedLongMemEvalPayload,
  loadMergeShards
} from "../../../cli/merge/command/merge-command-shards.js";
import { deriveMergedLongMemEvalReleaseAuthority } from
  "../../../cli/merge/release-evidence-authority.js";
import {
  buildLongMemEvalWorkerShardPlans,
  resolveDefaultBenchRunnerCliPath
} from "../../../datasets/longmemeval/runner/runner-concurrency.js";
import { validateShardRunProvenancePlans } from "../../provenance/shard-aggregate.js";
import { withLongMemEvalDiagnosticsSpool, type LongMemEvalDiagnosticsSpool } from
  "../../../diagnostics/spool.js";
import { finalizeOwnedTempRoot } from "../owned-temp-root.js";
import { throwLifecycleErrors } from "../errors.js";
import { recallEvalEmbeddingMode } from "./recall-eval-runtime.js";
import type { RecallEvalOptions, RecallEvalResult } from "./recall-eval-contract.js";
import {
  snapshotManifestPath,
  type LongMemEvalSnapshotManifest
} from "../../snapshot/materialize.js";
import type { MeasuredGitState } from "../../provenance/contract/worktree-state-measure.js";
import { validateSnapshotManifest } from "../../snapshot/manifest-validation.js";
import { MAX_SNAPSHOT_MANIFEST_BYTES } from "../../snapshot/artifact-limits.js";
import { readRegularFileNoFollow } from "../../snapshot/bound-file.js";
import {
  assertDistinctOverlayInodes,
  isolateEmbeddingCacheOverlayReceipt
} from "../../snapshot/recall-eval/workspace-slice/overlay-replicate.js";
import {
  buildRecallEvalWorkerCliArgs,
  buildRecallEvalWorkerEnv,
  RECALL_EVAL_SHARD_OVERLAY_DIRNAME,
  runSupervisedWorkerGroup,
  shardHasMergeableKpi,
  spawnLongMemEvalWorkerProcess,
  type LongMemEvalWorkerShardPlan,
  type LongMemEvalWorkerSpawner
} from "./recall-eval-shards-worker.js";

export interface RecallEvalShardDeps {
  readonly spawnWorker?: LongMemEvalWorkerSpawner;
  readonly resolveCliPath?: () => string;
  readonly resolveWindow?: (options: RecallEvalOptions) => Promise<{
    readonly baseOffset: number;
    readonly windowLength: number;
  }>;
  readonly loadSnapshotManifest?: (
    snapshotDbPath: string
  ) => Promise<LongMemEvalSnapshotManifest>;
  readonly recordedGitState?: MeasuredGitState;
}

interface RecallEvalShardedContext {
  readonly opts: RecallEvalOptions;
  readonly concurrency: number;
  readonly shardRoot: string;
  readonly plans: readonly LongMemEvalWorkerShardPlan[];
  readonly cliPath: string;
  readonly spawnWorker: LongMemEvalWorkerSpawner;
  readonly logDir: string;
  readonly snapshotManifest: LongMemEvalSnapshotManifest;
  readonly recordedGitState?: MeasuredGitState;
}

export function resolveRecallEvalConcurrency(opts: RecallEvalOptions): number {
  const raw = opts.concurrency ?? 1;
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 32) {
    throw new Error("recall-eval concurrency must be an integer from 1 to 32");
  }
  return raw;
}

export function shouldFanOutRecallEvalWorkers(opts: RecallEvalOptions): boolean {
  return resolveRecallEvalConcurrency(opts) > 1;
}

export function validateRecallEvalConcurrency(
  opts: RecallEvalOptions,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  if (!shouldFanOutRecallEvalWorkers(opts)) return;
  if (opts.dataDirRoot !== undefined) {
    throw new Error(
      "recall-eval --concurrency > 1 is incompatible with --data-dir-root; " +
        "each worker needs an isolated daemon DB."
    );
  }
  if ((env.ALAYA_RECALL_EVAL_MEMORY_PROFILE_PATH?.trim().length ?? 0) > 0) {
    throw new Error(
      "recall-eval --concurrency > 1 is incompatible with memory profiling; " +
        "a single profile cannot represent multiple worker processes"
    );
  }
  const unsupportedSubstrate = [
    opts.warmDerivedSnapshotReceiptPath === undefined ? null : "warm derived snapshot",
    opts.derivedEvidenceProjectionRebuild === true ? "derived projection rebuild" : null
  ].filter((value): value is string => value !== null);
  if (unsupportedSubstrate.length > 0) {
    throw new Error(
      "recall-eval --concurrency > 1 sealed slices cannot represent: " +
        unsupportedSubstrate.join(", ")
    );
  }
}

export function buildMergedPerQuestionDelivered(
  diagnostics: readonly Readonly<{
    readonly question_id: string;
    readonly delivered_results?: readonly Readonly<{ readonly object_id: string }>[];
    readonly delivered_memory_ids?: readonly string[];
  }>[],
  perScenario: readonly Readonly<{ readonly id: string }>[]
): ReadonlyMap<string, readonly string[]> {
  const expected = new Set(perScenario.map((row) => row.id));
  const byQuestion = new Map(diagnostics.map((question) => [question.question_id, question]));
  if (expected.size !== perScenario.length || byQuestion.size !== diagnostics.length ||
      diagnostics.length !== perScenario.length ||
      diagnostics.some((question) => !expected.has(question.question_id))) {
    throw new Error("recall-eval shard delivery coverage mismatch");
  }
  return new Map(perScenario.map((row) => {
    const question = byQuestion.get(row.id);
    if (question === undefined) throw new Error("recall-eval shard delivery coverage mismatch");
    const objectIds = question.delivered_results?.map((result) => result.object_id) ??
      question.delivered_memory_ids ?? [];
    return [row.id, Object.freeze([...objectIds])];
  }));
}

export function resolveRecallEvalShardWindow(
  options: Pick<RecallEvalOptions, "offset" | "limit">,
  questionCount: number
): { readonly baseOffset: number; readonly windowLength: number } {
  const baseOffset = Math.max(0, options.offset ?? 0);
  const sliceEnd = options.limit !== undefined
    ? baseOffset + options.limit
    : questionCount;
  const windowLength = Math.max(0, Math.min(sliceEnd, questionCount) - baseOffset);
  if (windowLength === 0) {
    throw new Error("recall-eval --concurrency: no questions in the selected window");
  }
  return { baseOffset, windowLength };
}

export function assertExactRecallEvalShardCoverage(
  plans: readonly LongMemEvalWorkerShardPlan[],
  baseOffset: number,
  windowLength: number
): void {
  let cursor = baseOffset;
  const end = baseOffset + windowLength;
  for (const plan of plans) {
    if (plan.offset !== cursor || plan.limit < 1) {
      throw new Error("recall-eval shard plan has a gap or overlap");
    }
    cursor += plan.limit;
  }
  if (cursor !== end) {
    throw new Error("recall-eval shard plan does not cover the exact expected window");
  }
}

export async function runRecallEvalSharded(
  options: RecallEvalOptions,
  deps: RecallEvalShardDeps = {}
): Promise<RecallEvalResult> {
  validateRecallEvalConcurrency(options);
  const context = await prepareRecallEvalShardedRun(options, deps);
  let succeeded = false;
  let result: RecallEvalResult | undefined;
  let primaryError: unknown;
  try {
    await runRecallEvalShardWorkers(context);
    result = await mergeRecallEvalShardedRun(context);
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
  throwLifecycleErrors("recall-eval concurrent lifecycle failed", [
    primaryError,
    cleanupError
  ]);
  if (result === undefined) {
    throw new Error("recall-eval concurrent run produced no result");
  }
  return result;
}

async function prepareRecallEvalShardedRun(
  opts: RecallEvalOptions,
  deps: RecallEvalShardDeps
): Promise<RecallEvalShardedContext> {
  const concurrency = resolveRecallEvalConcurrency(opts);
  const loadSnapshotManifest = deps.loadSnapshotManifest ?? defaultLoadSnapshotManifest;
  const snapshotManifest = await loadSnapshotManifest(opts.snapshotDbPath);
  const window = deps.resolveWindow === undefined
    ? resolveRecallEvalShardWindow(opts, snapshotManifest.question_count)
    : await deps.resolveWindow(opts);
  const shardRoot = await mkdtemp(join(tmpdir(), "alaya-recall-eval-shards-"));
  const plans = buildLongMemEvalWorkerShardPlans({
    windowLength: window.windowLength,
    baseOffset: window.baseOffset,
    concurrency,
    shardRoot
  });
  assertExactRecallEvalShardCoverage(plans, window.baseOffset, window.windowLength);
  isolateRecallEvalShardOverlays(opts, plans);
  const logDir = join(shardRoot, "logs");
  await mkdir(logDir, { recursive: true });
  const cliPath = deps.resolveCliPath?.() ?? resolveDefaultBenchRunnerCliPath();
  process.stdout.write(
    `[recall-eval concurrency] process-backed workers=${plans.length} ` +
      `window=${window.windowLength} cli=${cliPath}\n`
  );
  return {
    opts,
    concurrency,
    shardRoot,
    plans,
    cliPath,
    spawnWorker: deps.spawnWorker ?? spawnLongMemEvalWorkerProcess,
    logDir,
    snapshotManifest,
    ...(deps.recordedGitState === undefined ? {} : { recordedGitState: deps.recordedGitState })
  };
}

async function runRecallEvalShardWorkers(
  context: RecallEvalShardedContext
): Promise<void> {
  const results = await runSupervisedWorkerGroup({
    label: "recall-eval --concurrency",
    starts: context.plans.map((plan) => (signal) =>
      runRecallEvalShardWorker(context, plan, signal)),
    isFatal: (result) => result.fatal
  });
  if (results.some((result) => result.fatal)) {
    throw new Error(
      `recall-eval --concurrency: one or more worker processes failed (${
        results.map((result) => result.status).join(",")
      })`
    );
  }
}

async function runRecallEvalShardWorker(
  context: RecallEvalShardedContext,
  plan: LongMemEvalWorkerShardPlan,
  signal: AbortSignal
): Promise<{ readonly status: number; readonly fatal: boolean }> {
  const logPath = join(context.logDir, `shard-${plan.shardIndex}.log`);
  const status = await context.spawnWorker({
    cliPath: context.cliPath,
    args: buildRecallEvalWorkerCliArgs(context.opts, plan),
    env: buildRecallEvalWorkerEnv({
      concurrency: context.concurrency,
      embeddingMode: context.opts.embeddingMode ?? recallEvalEmbeddingMode(),
      shardRoot: context.shardRoot,
      historyRoot: plan.historyRoot
    }),
    logPath,
    signal
  });
  const mergeable = status === 1 && await shardHasMergeableKpi(plan.historyRoot);
  if (status !== 0) {
    process.stderr.write(mergeable
      ? `[recall-eval concurrency] shard ${plan.shardIndex} exited status=1 after writing KPI; allowing merge log=${logPath}\n`
      : `[recall-eval concurrency] shard ${plan.shardIndex} exited status=${status} log=${logPath}\n`);
  }
  return { status, fatal: status !== 0 && !mergeable };
}

async function mergeRecallEvalShardedRun(
  context: RecallEvalShardedContext
): Promise<RecallEvalResult> {
  return withLongMemEvalDiagnosticsSpool((diagnosticsSpool) =>
    mergeRecallEvalShardedRunWithSpool(context, diagnosticsSpool)
  );
}

async function mergeRecallEvalShardedRunWithSpool(
  context: RecallEvalShardedContext,
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<RecallEvalResult> {
  const shardRoots = context.plans.map((plan) => plan.historyRoot);
  process.stdout.write(
    `[recall-eval concurrency] merging ${shardRoots.length} shard(s) -> ${context.opts.historyRoot}\n`
  );
  const loaded = await loadMergeShards(shardRoots, diagnosticsSpool);
  const build = buildMergedLongMemEvalPayload(loaded);
  await validateShardRunProvenancePlans({
    shardArchiveRefs: loaded.archiveRefs,
    plans: context.plans,
    requestedConcurrency: context.concurrency,
    selectionContract: build.selectionContract,
    globalExtractionAuthority: loaded.globalExtractionAuthority
  });
  const archive = await writeMergedLongMemEvalArchive({
    historyRoot: context.opts.historyRoot,
    releaseEvidenceAuthority: deriveMergedLongMemEvalReleaseAuthority(
      null,
      loaded.archiveRefs
    ),
    build,
    shardArchiveRefs: loaded.archiveRefs,
    requestedConcurrency: context.concurrency,
    globalExtractionAuthority: loaded.globalExtractionAuthority,
    diagnosticsSpool,
    ...(context.recordedGitState === undefined
      ? {}
      : { recordedGitState: context.recordedGitState })
  });
  return {
    slug: archive.slug,
    kpiPath: archive.kpiPath,
    reportPath: join(dirname(archive.kpiPath), "report.md"),
    findingsPath: join(dirname(archive.kpiPath), "findings.md"),
    payload: archive.merged,
    snapshotManifest: context.snapshotManifest,
    perQuestionDelivered: buildMergedPerQuestionDelivered(
      loaded.questionDiagnostics,
      archive.merged.kpi.per_scenario
    ),
    completion: { status: "complete", failures: [] },
    memoryProfile: { status: "disabled", failures: [] }
  };
}

function isolateRecallEvalShardOverlays(
  opts: RecallEvalOptions,
  plans: readonly LongMemEvalWorkerShardPlan[]
): void {
  const receiptPath = opts.embeddingCacheOverlayReceiptPath;
  if (receiptPath === undefined) return;
  const isolated = plans.map((plan) => isolateEmbeddingCacheOverlayReceipt({
    receiptPath,
    destDir: join(plan.historyRoot, RECALL_EVAL_SHARD_OVERLAY_DIRNAME)
  }));
  assertDistinctOverlayInodes(isolated.map((row) => row.overlayPath));
}

function defaultLoadSnapshotManifest(
  snapshotDbPath: string
): Promise<LongMemEvalSnapshotManifest> {
  const path = snapshotManifestPath(snapshotDbPath);
  const bytes = readRegularFileNoFollow(path, MAX_SNAPSHOT_MANIFEST_BYTES);
  const parsed = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  ) as unknown;
  return Promise.resolve(validateSnapshotManifest(parsed, path));
}
