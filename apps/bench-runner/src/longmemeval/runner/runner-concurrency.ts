import {
  mkdir,
  mkdtemp,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeMergedLongMemEvalArchive } from "../../cli/merge/command/merge-command-archive.js";
import {
  buildMergedLongMemEvalPayload,
  loadMergeShards
} from "../../cli/merge/command/merge-command-shards.js";
import { loadDatasetWithIdentity } from "../ingestion/fetch.js";
import type { VerifiedLongMemEvalDatasetAuthority } from "../ingestion/fetch.js";
import type { LongMemEvalRunOptions, LongMemEvalRunResult } from "../runner.js";
import { finalizeOwnedTempRoot } from "../lifecycle/owned-temp-root.js";
import { throwLifecycleErrors } from "../lifecycle/errors.js";
import { validateShardRunProvenancePlans } from "../provenance/shard-aggregate.js";
import {
  withLongMemEvalDiagnosticsSpool,
  type LongMemEvalDiagnosticsSpool
} from "../diagnostics/spool.js";
import { readOptionalTreatmentBoolean } from "../../harness/strict-treatment-config.js";
import { loadQuestionManifestSelection } from "../selection/question-manifest.js";
import { deriveMergedLongMemEvalReleaseAuthority } from
  "../../cli/merge/release-evidence-authority.js";
import {
  LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME
} from "../provenance/contract/extraction-authority-reference.js";
import {
  verifiedExpansionRunAuthority,
  type VerifiedExpansionRunAuthority
} from "../promotion/expansion/authority/expansion-run-authority.js";
import {
  buildLongMemEvalFanoutAuthority,
  longMemEvalFanoutChildEnv,
  type BuiltLongMemEvalFanoutAuthority
} from "../promotion/fanout-authority.js";
import {
  buildLongMemEvalWorkerCliArgs,
  buildCredentiallessLongMemEvalWorkerEnv,
  buildLongMemEvalWorkerEnvOverrides,
  shardHasMergeableKpi,
  spawnLongMemEvalWorkerProcess,
  type LongMemEvalWorkerShardPlan,
  type LongMemEvalWorkerSpawner
} from "./runner-concurrency-worker.js";

export {
  buildLongMemEvalWorkerCliArgs,
  buildCredentiallessLongMemEvalWorkerEnv,
  buildLongMemEvalWorkerEnvOverrides,
  freezeProcessEnvForWorkers,
  type LongMemEvalWorkerShardPlan,
  type LongMemEvalWorkerSpawnOptions,
  type LongMemEvalWorkerSpawner
} from "./runner-concurrency-worker.js";

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
  readonly expansionAuthority: VerifiedExpansionRunAuthority | null;
  readonly fanoutAuthority: BuiltLongMemEvalFanoutAuthority | null;
}

export function resolveLongMemEvalConcurrency(opts: LongMemEvalRunOptions): number {
  const raw = opts.concurrency ?? 1;
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 32) {
    throw new Error("longmemeval concurrency must be an integer from 1 to 32");
  }
  return raw;
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

export function assertExactLongMemEvalShardCoverage(
  plans: readonly LongMemEvalWorkerShardPlan[],
  expectedCount: number
): void {
  let cursor = 0;
  for (const plan of plans) {
    if (plan.offset !== cursor || plan.limit < 1) {
      throw new Error("longmemeval shard plan has a gap or overlap");
    }
    cursor += plan.limit;
  }
  if (cursor !== expectedCount) {
    throw new Error("longmemeval shard plan does not cover the exact expected window");
  }
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
  const { expansionAuthority, fanoutAuthority } = await materializeRunAuthorities({
    opts, concurrency, plans
  }, shardRoot);
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
    datasetAuthority: selection.datasetAuthority,
    expansionAuthority,
    fanoutAuthority
  };
}

async function materializeRunAuthorities(
  input: Omit<Parameters<typeof buildConcurrentFanoutAuthority>[0],
    "expansionAuthority">,
  shardRoot: string
): Promise<{
  readonly expansionAuthority: VerifiedExpansionRunAuthority | null;
  readonly fanoutAuthority: BuiltLongMemEvalFanoutAuthority | null;
}> {
  const expansionAuthority = verifiedExpansionRunAuthority(
    input.opts.expansionCapability
  );
  if (input.opts.expansionCapability !== undefined && expansionAuthority === null) {
    throw new Error("500Q process fan-out requires live expansion run authority");
  }
  if (expansionAuthority !== null) {
    assertExactLongMemEvalShardCoverage(input.plans, expansionAuthority.questionCount);
    await writeFile(
      join(shardRoot, LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME),
      expansionAuthority.extraction.bytes,
      { flag: "wx" }
    );
  }
  const fanoutAuthority = buildConcurrentFanoutAuthority({
    ...input,
    expansionAuthority
  });
  if (fanoutAuthority !== null) {
    await writeFile(join(shardRoot, fanoutAuthority.descriptor.path),
      fanoutAuthority.bytes, { flag: "wx" });
  }
  return { expansionAuthority, fanoutAuthority };
}

function buildConcurrentFanoutAuthority(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly concurrency: number;
  readonly plans: readonly LongMemEvalWorkerShardPlan[];
  readonly expansionAuthority: VerifiedExpansionRunAuthority | null;
}): BuiltLongMemEvalFanoutAuthority | null {
  if (input.expansionAuthority === null) return null;
  if (input.opts.expansionCapability === undefined) {
    throw new Error("500Q fanout requires a live expansion capability");
  }
  return buildLongMemEvalFanoutAuthority({
    capability: input.opts.expansionCapability,
    extraction: input.expansionAuthority.extraction,
    requestedConcurrency: input.concurrency,
    plans: input.plans.map((plan) => ({
      shard_index: plan.shardIndex,
      offset: plan.offset,
      limit: plan.limit
    }))
  });
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
    args: buildLongMemEvalWorkerCliArgs(context.opts, plan),
    env: buildCredentiallessLongMemEvalWorkerEnv(
      process.env,
      {
        ...buildLongMemEvalWorkerEnvOverrides({
          concurrency: context.concurrency,
          embeddingMode: context.opts.embeddingMode,
          crossEncoderEnabled: readOptionalTreatmentBoolean(
            process.env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK,
            "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
          ) === true,
          shardRoot: context.shardRoot,
          historyRoot: plan.historyRoot
        }),
        ...(context.fanoutAuthority === null ? {} :
          longMemEvalFanoutChildEnv({
            root: context.shardRoot,
            descriptor: context.fanoutAuthority.descriptor,
            shardIndex: plan.shardIndex
          }))
      }
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
    selectionContract: build.selectionContract,
    globalExtractionAuthority: loaded.globalExtractionAuthority
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
    globalExtractionAuthority: loaded.globalExtractionAuthority,
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
