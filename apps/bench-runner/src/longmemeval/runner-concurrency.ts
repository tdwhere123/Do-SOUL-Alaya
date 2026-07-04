import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeMergedLongMemEvalArchive } from "../cli/merge-command-archive.js";
import {
  buildMergedLongMemEvalPayload,
  loadMergeShards
} from "../cli/merge-command-shards.js";
import { loadDataset } from "./fetch.js";
import type { LongMemEvalVariant } from "./dataset.js";
import type { LongMemEvalRunOptions, LongMemEvalRunResult } from "./runner.js";

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

export function freezeProcessEnvForWorkers(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return Object.freeze({ ...env });
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
}

export async function runLongMemEvalConcurrent(
  opts: LongMemEvalRunOptions,
  deps: LongMemEvalConcurrencyDeps = {}
): Promise<LongMemEvalRunResult> {
  validateLongMemEvalConcurrency(opts);
  const concurrency = resolveLongMemEvalConcurrency(opts);
  const questions = await loadDataset(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const baseOffset = Math.max(0, opts.offset ?? 0);
  const sliceEnd =
    opts.limit !== undefined ? baseOffset + opts.limit : questions.length;
  const windowLength = Math.max(0, Math.min(sliceEnd, questions.length) - baseOffset);
  if (windowLength === 0) {
    throw new Error("longmemeval --concurrency: no questions in the selected window");
  }

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

  let exitFail = 0;
  try {
    const results = await Promise.all(
      plans.map(async (plan) => {
        const logPath = join(logDir, `shard-${plan.shardIndex}.log`);
        const status = await spawnWorker({
          cliPath,
          args: buildWorkerCliArgs(opts, plan),
          env: freezeProcessEnvForWorkers(),
          logPath
        });
        if (status !== 0) {
          const mergeableGateFailure =
            status === 1 && (await shardHasMergeableKpi(plan.historyRoot));
          if (mergeableGateFailure) {
            process.stderr.write(
              `[longmemeval concurrency] shard ${plan.shardIndex} exited status=1 ` +
                `after writing KPI; allowing merge log=${logPath}\n`
            );
          } else {
            process.stderr.write(
              `[longmemeval concurrency] shard ${plan.shardIndex} exited status=${status} ` +
                `log=${logPath}\n`
            );
            exitFail = 1;
          }
        }
        return status;
      })
    );
    if (exitFail !== 0) {
      throw new Error(
        `longmemeval --concurrency: one or more worker processes failed (${results.join(",")})`
      );
    }

    const shardRoots = plans.map((plan) => plan.historyRoot);
    process.stdout.write(
      `[longmemeval concurrency] merging ${shardRoots.length} shard(s) -> ${opts.historyRoot}\n`
    );
    const loaded = await loadMergeShards(shardRoots);
    const build = buildMergedLongMemEvalPayload(loaded);
    const archive = await writeMergedLongMemEvalArchive({
      historyRoot: opts.historyRoot,
      build,
      shardArchiveRefs: loaded.archiveRefs
    });
    return {
      slug: archive.slug,
      kpiPath: archive.kpiPath,
      reportPath: join(dirname(archive.kpiPath), "report.md"),
      findingsPath: join(dirname(archive.kpiPath), "findings.md"),
      diagnosticsPath: archive.diagnosticsPath,
      payload: archive.merged
    };
  } finally {
    await rm(shardRoot, { recursive: true, force: true });
  }
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
