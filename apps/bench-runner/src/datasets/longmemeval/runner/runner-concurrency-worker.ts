import { spawn } from "node:child_process";
import { access, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LongMemEvalVariant } from "../ingestion/dataset.js";
import type { LongMemEvalRunOptions } from "../runner.js";

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
  readonly signal: AbortSignal;
}

export type LongMemEvalWorkerSpawner = (
  options: LongMemEvalWorkerSpawnOptions
) => Promise<number>;

export async function runSupervisedWorkerGroup<T>(input: {
  readonly label: string;
  readonly starts: readonly ((signal: AbortSignal) => Promise<T>)[];
  readonly isFatal: (result: T) => boolean;
}): Promise<readonly T[]> {
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | null = null;
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted = signal;
    controller.abort(new Error(`${input.label} interrupted by ${signal}`));
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    const settled = await Promise.allSettled(input.starts.map((start) =>
      Promise.resolve().then(() => start(controller.signal)).then((result) => {
        if (input.isFatal(result)) controller.abort(new Error(`${input.label} worker failed`));
        return result;
      }, (error: unknown) => {
        controller.abort(error);
        throw error;
      })
    ));
    if (interrupted !== null) throw new Error(`${input.label} interrupted by ${interrupted}`);
    const errors = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) {
      const first = errors[0];
      const detail = first instanceof Error ? first.message : String(first);
      throw new AggregateError(errors, `${input.label}: ${detail}`);
    }
    return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

export function freezeProcessEnvForWorkers(
  env: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return Object.freeze({ ...env, ...overrides });
}

export function buildCredentiallessLongMemEvalWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const entries = Object.entries({ ...env, ...overrides })
    .filter(([name, value]) => value !== undefined && !isRemoteSecretEnv(name));
  return Object.freeze(Object.fromEntries(entries));
}

/** Shared ONNX single-flight lock for concurrent env-embedding workers. */
export function buildLongMemEvalWorkerEnvOverrides(input: {
  readonly concurrency: number;
  readonly embeddingMode: LongMemEvalRunOptions["embeddingMode"];
  readonly shardRoot: string;
  readonly historyRoot: string;
}): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = {
    ALAYA_BENCH_ARTIFACT_ROOT: join(input.historyRoot, ".bench-artifacts")
  };
  if (input.concurrency > 1 && input.embeddingMode === "env") {
    overrides.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT = "1";
    overrides.ALAYA_LOCAL_ONNX_LOCK_PATH = join(
      input.shardRoot,
      "local-onnx-inference.lock"
    );
  }
  return overrides;
}

export function buildLongMemEvalWorkerCliArgs(
  opts: LongMemEvalRunOptions,
  plan: LongMemEvalWorkerShardPlan
): string[] {
  const args = baseWorkerArgs(opts, plan);
  pushOptionalArgs(args, opts);
  return args;
}

export async function spawnLongMemEvalWorkerProcess(
  options: LongMemEvalWorkerSpawnOptions
): Promise<number> {
  const logHandle = await open(options.logPath, "w");
  try {
    return await waitForWorkerProcess(options, logHandle.fd);
  } finally {
    await logHandle.close();
  }
}

function waitForWorkerProcess(
  options: LongMemEvalWorkerSpawnOptions,
  logFd: number
): Promise<number> {
  if (options.signal.aborted) return Promise.reject(workerAbortError(options.signal));
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(process.execPath, [options.cliPath, ...options.args], {
      env: options.env,
      stdio: ["ignore", logFd, logFd]
    });
    let killTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      options.signal.removeEventListener("abort", onAbort);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      resolveExit(code ?? 1);
    });
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  });
}

function workerAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("worker process aborted");
}

export async function shardHasMergeableKpi(historyRoot: string): Promise<boolean> {
  const publicRoot = join(historyRoot, "public");
  try {
    const entries = await readdir(publicRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
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

function baseWorkerArgs(
  opts: LongMemEvalRunOptions,
  plan: LongMemEvalWorkerShardPlan
): string[] {
  return [
    "longmemeval", "--variant", variantToCliFlag(opts.variant),
    "--offset", String(plan.offset), "--limit", String(plan.limit),
    "--embedding", opts.embeddingMode ?? "disabled",
    "--policy-shape", opts.policyShape ?? "stress",
    "--simulate-report", opts.simulateReport ?? "none",
    "--history-root", plan.historyRoot
  ];
}

function pushOptionalArgs(args: string[], opts: LongMemEvalRunOptions): void {
  pushOptionalArg(args, "--embedding-provider", opts.embeddingProviderKind);
  pushOptionalArg(args, "--weights", opts.weightOverridesJson);
  pushOptionalArg(args, "--data-dir", opts.dataDir);
  pushOptionalArg(args, "--pinned-meta-root", opts.pinnedMetaRoot);
  pushOptionalArg(args, "--extraction-cache-root", opts.extractionCacheRoot);
  pushOptionalArg(args, "--promotion-contract", opts.promotionContractPath);
  pushOptionalArg(
    args,
    "--expected-reconciliation-basis",
    opts.expectedReconciliationBasis
  );
}

function pushOptionalArg(
  args: string[],
  name: string,
  value: string | undefined
): void {
  if (value !== undefined) args.push(name, value);
}

function variantToCliFlag(variant: LongMemEvalVariant): string {
  const map: Record<LongMemEvalVariant, string> = {
    longmemeval_oracle: "oracle",
    longmemeval_s: "s",
    longmemeval_m: "m"
  };
  return map[variant];
}

function isRemoteSecretEnv(name: string): boolean {
  const key = name.toUpperCase();
  return /(?:^|_)(?:OPENAI|DEEPSEEK|ANTHROPIC|GEMINI|QA)(?:_|$)/u.test(key) ||
    /^ALAYA_(?:GARDEN|CONFLICT_LLM|EDGE_PRODUCER_LLM)_/u.test(key) ||
    /^OFFICIAL_API_/u.test(key) || key === "ALAYA_BENCH_ALLOW_LIVE_EXTRACTION" ||
    /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTHORIZATION)(?:_|$)/u
      .test(key) ||
    /(?:_URL|_URI|_ENDPOINT)$/u.test(key) ||
    /(?:SECRET|CREDENTIAL|TOKEN|KEY)_(?:REF|FILE|PATH)$/u.test(key);
}
