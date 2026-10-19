#!/usr/bin/env node
// Orchestrates sequential LongMemEval-S and LoCoMo embedding-off full benches
// (step ids lme-s and locomo-off).
//
// Long-running bench-runner daemons are single-process (each step opens one
// daemon and reuses it across every question via attachWorkspace). Within a
// step shards is implicitly 1; across steps the orchestrator runs strictly
// sequentially so the two daemons never coexist (WSL2 7.6 GiB cap).
//
// Each step spawns the bench-runner as an attached child and awaits its exit
// before launching the next. stdout/stderr per step land under
// var/bench-logs/v0.3.11/.
//
// Operator matrix (docs/bench-history/README.md):
//   lme-s       longmemeval-s   embedding=disabled         policy=chat  -> R@5 >= 90%
//   locomo-off  locomo          embedding=disabled         policy=chat  -> R@5 >= 55%
//
// lme-mt, lme-cq, and locomo-on are deferred and are not orchestrated by this
// script.
//
// Each step writes its archive under the matching local history <root>/
// subtree; the script verifies a fresh archive slug appeared and contains
// kpi.json before continuing.
//
// Usage:
//   export OFFICIAL_API_GARDEN_MODEL=<model>   # or source your bench env file
//   node scripts/run-full-bench-v0311.mjs                        # both benches
//   node scripts/run-full-bench-v0311.mjs --bench lme-s          # single bench id
//   node scripts/run-full-bench-v0311.mjs --bench lme-s,locomo-off  # comma list
//   node scripts/run-full-bench-v0311.mjs --policy-shape stress  # override (default chat)
//   node scripts/run-full-bench-v0311.mjs --limit 50             # smoke; not release-grade
//   node scripts/run-full-bench-v0311.mjs --data-dir /tmp/bench  # override dataset root
//                                                                # (default: apps/bench-runner/data)
//   node scripts/run-full-bench-v0311.mjs --history-root <path>  # override archive root
//   node scripts/run-full-bench-v0311.mjs --dry-run              # print commands only
//   node scripts/run-full-bench-v0311.mjs --resume               # reuse matching completed benches
//   node scripts/run-full-bench-v0311.mjs --help
//
// Detached operator launch:
//   setsid node scripts/run-full-bench-v0311.mjs \
//     > /tmp/v0311-full.log 2>&1 < /dev/null &
//   disown
//
// Resume semantics: --resume reuses a step only when its checkpoint under
// <log-root>/<id>.done records the same requested run identity (dataset dir,
// history root, extraction cache, limit, policy shape, code revision) and the
// recorded archive still contains kpi.json. A missing, legacy, mismatched, or
// unverifiable checkpoint blocks the run instead of skipping it or starting a
// replacement bench; remove the checkpoint or rerun without --resume to run it
// explicitly.
// Per-question intra-step resume (skip already-completed questions inside a
// single bench) is NOT implemented; if a 500Q LongMemEval run crashes midway
// the entire step re-runs. See unknowns in the worker return for follow-up.
//
// Exit codes:
//   0  every requested bench produced a fresh archive with kpi.json
//   1  one bench exited non-zero, archive verification failed, or a resume
//      checkpoint could not be revalidated
//   2  bad CLI argument

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatDuration, parseArgs, selectSteps } from "./run-full-bench-v0311-cli.mjs";
import { resolveDefaultBenchHistoryRoot } from "../packages/eval/dist/index.js";
import { resolveEffectiveExtractionCacheRoot } from "../apps/bench-runner/dist/runs/compile-seed/compile-seed-config.js";
import { resolveBenchCommitSha7 } from "../apps/bench-runner/dist/shared/version.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_HISTORY_ROOT = resolveDefaultBenchHistoryRoot(REPO_ROOT);
const LOG_ROOT = path.join(REPO_ROOT, "var/bench-logs/v0.3.11");
const BENCH_RUNNER = path.join(
  REPO_ROOT,
  "apps/bench-runner/bin/alaya-bench-runner.mjs"
);
const GARDEN_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";
const BENCH_ENV_SOURCE_COMMAND =
  `export ${GARDEN_MODEL_ENV}=<model> (or source your bench environment file)`;
const CHECKPOINT_VERSION = 1;

// Detached launches must bind the same model as the selected cache before
// spawning a bench; credentials or another cache cannot repair that identity.
function assertGardenModelEnv(extractionCacheRoot) {
  const present =
    typeof process.env[GARDEN_MODEL_ENV] === "string" &&
    process.env[GARDEN_MODEL_ENV].trim().length > 0;
  const manifestModel = readManifestExtractionModel(extractionCacheRoot);
  if (!present) {
    throw new Error(
      `${GARDEN_MODEL_ENV} is not set; the selected cache requires model ${manifestModel}. ` +
        `Bind the matching model before launching: ${BENCH_ENV_SOURCE_COMMAND}`
    );
  }
  if (
    process.env[GARDEN_MODEL_ENV].trim() !== manifestModel
  ) {
    throw new Error(
      `${GARDEN_MODEL_ENV}=${process.env[GARDEN_MODEL_ENV]} does not match ` +
        `the extraction cache manifest model ${manifestModel}. ` +
        `Set ${GARDEN_MODEL_ENV}=${manifestModel} or explicitly select the matching cache; no bench was started.`
    );
  }
}

function readManifestExtractionModel(extractionCacheRoot) {
  const manifestPath = path.join(extractionCacheRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`selected extraction cache manifest is missing: ${manifestPath}; prepare this cache explicitly before running`);
  }
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  const model = parsed?.extraction_model;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error(`selected extraction cache manifest has no extraction_model: ${manifestPath}`);
  }
  return model;
}

// id is the short selector for --bench; archiveRoot is the bench-history
// subdirectory the harness writes to.
const BENCH_STEPS = [
  {
    id: "lme-s",
    label: "lme-s LongMemEval-S embedding-off",
    archiveRoot: "public",
    args: (ctx) => [
      "longmemeval",
      "--variant", "s",
      "--embedding", "disabled",
      "--policy-shape", ctx.policyShape,
      "--data-dir", path.join(ctx.dataDir, "longmemeval"),
      ...(ctx.limit !== undefined ? ["--limit", String(ctx.limit)] : []),
      "--history-root", ctx.historyRoot
    ]
  },
  {
    id: "locomo-off",
    label: "locomo-off LoCoMo embedding-off",
    archiveRoot: "public-locomo",
    args: (ctx) => [
      "locomo",
      "--embedding", "disabled",
      "--policy-shape", ctx.policyShape,
      "--data-dir", path.join(ctx.dataDir, "locomo"),
      ...(ctx.limit !== undefined ? ["--limit", String(ctx.limit)] : []),
      "--history-root", ctx.historyRoot
    ]
  }
];

const HELP_TEXT = `run-full-bench-v0311 — sequential full-bench orchestrator

Usage:
  node scripts/run-full-bench-v0311.mjs [flags]

Flags:
  --bench <ids>            Comma-separated subset (default: all). Valid ids:
                           ${BENCH_STEPS.map((s) => s.id).join(", ")}
  --policy-shape <shape>   Bench policy shape (default: chat)
  --limit <N>              Per-bench --limit (default: undefined / full set)
  --data-dir <path>        Dataset root containing longmemeval/ and
                           locomo/ subdirs (default: $ALAYA_BENCH_DATA_DIR or
                           <repo>/apps/bench-runner/data)
  --history-root <path>    Archive root (default: <repo>/.bench-artifacts/history)
  --extraction-cache-root <path>  Cache root (explicit, then environment, then local default)
  --log-root <path>        Log root (default: <repo>/var/bench-logs/v0.3.11)
  --dry-run                Print commands without executing
  --resume                 Reuse only completed steps whose checkpoint matches
                           the requested dataset, history root, extraction
                           cache, limit, policy, and code revision, and whose
                           archive still has kpi.json; otherwise block without
                           starting a bench
  --help                   Show this help

Exit codes:
  0  all requested benches completed and archived
  1  one bench failed or archive verification failed
  2  bad CLI argument
`;
function timestamp() {
  // ISO 8601 UTC, colon-stripped to be filesystem-safe (matches bench harness).
  return new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
}

function listArchiveSlugs(root) {
  if (!existsSync(root)) return new Set();
  try {
    return new Set(
      readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    );
  } catch {
    return new Set();
  }
}

function findNewArchive(root, beforeSet) {
  if (!existsSync(root)) return null;
  const after = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const fresh = after.filter((name) => !beforeSet.has(name));
  if (fresh.length === 0) return null;
  // Latest by lex order (timestamps make this chronological).
  fresh.sort();
  return path.join(root, fresh[fresh.length - 1]);
}

function sentinelPath(logRoot, stepId) {
  return path.join(logRoot, `${stepId}.done`);
}

function requestedRunIdentity(step, ctx) {
  return {
    step_id: step.id,
    data_dir: ctx.dataDir,
    history_root: ctx.historyRoot,
    extraction_cache_root: ctx.extractionCacheRoot,
    archive_root: path.join(ctx.historyRoot, step.archiveRoot),
    limit: ctx.limit ?? null,
    policy_shape: ctx.policyShape,
    revision: resolveBenchCommitSha7()
  };
}

// One verification path for both a fresh step and a resumed checkpoint: the
// archive directory must exist and contain the kpi.json written on completion.
function archiveContainsKpi(archivePath) {
  return (
    typeof archivePath === "string" &&
    archivePath.length > 0 &&
    existsSync(archivePath) &&
    existsSync(path.join(archivePath, "kpi.json"))
  );
}

function readCheckpoint(sentinel) {
  let checkpoint;
  try {
    checkpoint = JSON.parse(readFileSync(sentinel, "utf8"));
  } catch (err) {
    return {
      reusable: false,
      reason: `checkpoint is not readable JSON (${err.message})`
    };
  }
  if (checkpoint?.checkpoint_version !== CHECKPOINT_VERSION) {
    return {
      reusable: false,
      reason:
        `checkpoint version ${JSON.stringify(checkpoint?.checkpoint_version ?? null)} ` +
        `is not supported (expected ${CHECKPOINT_VERSION})`
    };
  }
  if (
    checkpoint.request === null ||
    typeof checkpoint.request !== "object" ||
    Array.isArray(checkpoint.request)
  ) {
    return { reusable: false, reason: "checkpoint has no requested-run identity" };
  }
  return { reusable: true, checkpoint };
}

function describeIdentityMismatch(expected, recorded) {
  for (const key of Object.keys(expected)) {
    if (recorded[key] !== expected[key]) {
      return `${key} recorded=${JSON.stringify(recorded[key])} ` +
        `requested=${JSON.stringify(expected[key])}`;
    }
  }
  return null;
}

function resolveCheckpointReuse(step, ctx, sentinel) {
  const read = readCheckpoint(sentinel);
  if (!read.reusable) return read;
  const mismatch = describeIdentityMismatch(
    requestedRunIdentity(step, ctx),
    read.checkpoint.request
  );
  if (mismatch !== null) {
    return {
      reusable: false,
      reason: `requested run differs from checkpoint: ${mismatch}`
    };
  }
  if (!archiveContainsKpi(read.checkpoint.archive_path)) {
    return {
      reusable: false,
      reason:
        `recorded archive is missing or has no kpi.json: ` +
        `${read.checkpoint.archive_path ?? "(none)"}`
    };
  }
  return { reusable: true, checkpoint: read.checkpoint };
}

function buildContext(args) {
  const dataDir =
    args.dataDir ??
    process.env.ALAYA_BENCH_DATA_DIR ??
    path.join(REPO_ROOT, "apps/bench-runner/data");
  return {
    policyShape: args.policyShape,
    limit: args.limit,
    dataDir: path.resolve(dataDir),
    extractionCacheRoot: resolveEffectiveExtractionCacheRoot(args.extractionCacheRoot, process.env),
    historyRoot: args.historyRoot
  };
}

function formatCommand(argv) {
  return ["node", BENCH_RUNNER, ...argv]
    .map((tok) => (/\s/.test(tok) ? JSON.stringify(tok) : tok))
    .join(" ");
}

async function runStep(step, ctx, args) {
  const stepArgv = step.args(ctx);
  const archiveDir = path.join(ctx.historyRoot, step.archiveRoot);
  mkdirSync(args.logRoot, { recursive: true });
  const ts = timestamp();
  const logPath = path.join(args.logRoot, `${step.id}-${ts}.log`);
  const command = formatCommand(stepArgv);

  process.stdout.write(`\n=== ${step.label} ===\n`);
  process.stdout.write(`step_id=${step.id}\n`);
  process.stdout.write(`archive_root=${archiveDir}\n`);
  process.stdout.write(`log=${logPath}\n`);
  process.stdout.write(`command=${command}\n`);

  if (args.dryRun) {
    return { ok: true, code: 0, durationMs: 0, archivePath: null, logPath };
  }

  const beforeSlugs = listArchiveSlugs(archiveDir);
  const started = Date.now();

  const logFd = openSync(logPath, "a");
  let child;
  try {
    // Cap the runner's V8 old space so Node GCs hard before the OS OOM-killer
    // SIGKILLs the long single-process run. ~5000 MiB leaves headroom under the
    // 7.6 GiB WSL2 box for native better-sqlite3 RSS + OS.
    // Stay attached: the orchestrator must hold its event loop open on
    // `await child.once("exit")` so step N+1 launches only after step N's
    // runner exits. A detached unref'd child releases the parent loop and the
    // orchestrator exits 0 immediately, launching every step's runner at once
    // and starving them on the 7.6 GiB box.
    child = spawn(
      process.execPath,
      ["--max-old-space-size=5000", BENCH_RUNNER, ...stepArgv],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ALAYA_BENCH_EXTRACTION_CACHE_ROOT: ctx.extractionCacheRoot },
        stdio: ["ignore", logFd, logFd]
      }
    );
  } catch (err) {
    closeSync(logFd);
    throw err;
  }

  const code = await new Promise((resolve, reject) => {
    child.once("exit", (exitCode, signal) => {
      closeSync(logFd);
      if (exitCode === null) {
        // killed by signal
        resolve(signal ? 128 : 1);
      } else {
        resolve(exitCode);
      }
    });
    child.once("error", (err) => {
      closeSync(logFd);
      reject(err);
    });
  });

  const durationMs = Date.now() - started;
  const archivePath = findNewArchive(archiveDir, beforeSlugs);
  const archiveOk = archiveContainsKpi(archivePath);

  if (code === 0 && archiveOk) {
    writeFileSync(
      sentinelPath(args.logRoot, step.id),
      JSON.stringify(
        {
          checkpoint_version: CHECKPOINT_VERSION,
          request: requestedRunIdentity(step, ctx),
          completed_at: new Date().toISOString(),
          archive_path: archivePath,
          log_path: logPath,
          duration_ms: durationMs
        },
        null,
        2
      ) + "\n"
    );
  }

  return {
    ok: code === 0 && archiveOk,
    code,
    durationMs,
    archivePath,
    logPath,
    archiveOk
  };
}

function resolveRunConfig() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), { defaultHistoryRoot: DEFAULT_HISTORY_ROOT, defaultLogRoot: LOG_ROOT });
  } catch (err) {
    process.stderr.write(`run-full-bench-v0311: ${err.message}\n`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return { help: true };
  }

  let steps;
  try {
    steps = selectSteps(args.benches, BENCH_STEPS);
  } catch (err) {
    process.stderr.write(`run-full-bench-v0311: ${err.message}\n`);
    process.exit(2);
  }

  const ctx = buildContext(args);

  // --dry-run only prints commands; every executing run validates its cache
  // identity before a child can start.
  if (!args.dryRun) {
    try {
      assertGardenModelEnv(ctx.extractionCacheRoot);
    } catch (err) {
      process.stderr.write(`run-full-bench-v0311: ${err.message}\n`);
      process.exit(2);
    }
  }

  return { help: false, args, steps, ctx };
}

function printRunBanner(args, ctx, steps) {
  process.stdout.write(`run-full-bench-v0311 starting\n`);
  process.stdout.write(`  repo_root=${REPO_ROOT}\n`);
  process.stdout.write(`  data_dir=${ctx.dataDir}\n`);
  process.stdout.write(`  history_root=${ctx.historyRoot}\n`);
  process.stdout.write(`  extraction_cache_root=${ctx.extractionCacheRoot}\n`);
  process.stdout.write(`  log_root=${args.logRoot}\n`);
  process.stdout.write(`  policy_shape=${ctx.policyShape}\n`);
  process.stdout.write(`  limit=${ctx.limit ?? "(none / full set)"}\n`);
  process.stdout.write(`  dry_run=${args.dryRun}\n`);
  process.stdout.write(`  resume=${args.resume}\n`);
  process.stdout.write(`  steps=${steps.map((s) => s.id).join(",")}\n`);
}

async function executeSteps(args, ctx, steps) {
  const results = [];
  let firstFailure = null;

  for (const step of steps) {
    const sentinel = sentinelPath(args.logRoot, step.id);
    if (args.resume && existsSync(sentinel)) {
      const reuse = resolveCheckpointReuse(step, ctx, sentinel);
      if (reuse.reusable) {
        process.stdout.write(
          `\n=== ${step.label} ===\n` +
            `SKIP (resume checkpoint matches: ${sentinel})\n`
        );
        results.push({
          step,
          skipped: true,
          ok: true,
          code: 0,
          durationMs: 0,
          archivePath: reuse.checkpoint.archive_path,
          logPath: reuse.checkpoint.log_path ?? null
        });
        continue;
      }
      process.stderr.write(
        `step ${step.id} checkpoint is not reusable: ${reuse.reason}\n` +
          `No bench was started. Remove ${sentinel} or rerun without ` +
          `--resume to run this step again.\n`
      );
      const blocked = {
        step,
        skipped: false,
        blocked: true,
        ok: false,
        code: 1,
        durationMs: 0,
        archivePath: null,
        logPath: null
      };
      results.push(blocked);
      firstFailure = { step, outcome: blocked };
      break;
    }

    let outcome;
    try {
      outcome = await runStep(step, ctx, args);
    } catch (err) {
      process.stderr.write(
        `step ${step.id} failed to launch: ${err.message}\n`
      );
      outcome = {
        ok: false,
        code: 1,
        durationMs: 0,
        archivePath: null,
        logPath: null,
        archiveOk: false
      };
    }
    results.push({ step, skipped: false, ...outcome });

    if (!args.dryRun) {
      process.stdout.write(
        `step ${step.id} exit_code=${outcome.code} duration=${formatDuration(
          outcome.durationMs
        )} archive=${outcome.archivePath ?? "(none)"} archive_ok=${
          outcome.archiveOk ?? false
        }\n`
      );
    }

    if (!outcome.ok && !args.dryRun) {
      firstFailure = { step, outcome };
      process.stderr.write(
        `aborting remaining steps after failure in ${step.id}; ` +
          `inspect ${outcome.logPath ?? "(no log)"} for details\n`
      );
      break;
    }
  }

  return { results, firstFailure };
}

function printSummary(args, results, totalMs) {
  process.stdout.write(`\n=== summary ===\n`);
  process.stdout.write(`total_wall_clock=${formatDuration(totalMs)}\n`);
  for (const r of results) {
    if (r.skipped) {
      process.stdout.write(
        `  ${r.step.id}: SKIP (resume)\n`
      );
    } else if (r.blocked) {
      process.stdout.write(`  ${r.step.id}: BLOCKED (resume checkpoint)\n`);
    } else if (args.dryRun) {
      process.stdout.write(`  ${r.step.id}: DRY-RUN\n`);
    } else {
      process.stdout.write(
        `  ${r.step.id}: ${r.ok ? "OK" : "FAIL"} (exit=${r.code}, ` +
          `duration=${formatDuration(r.durationMs)}, ` +
          `archive=${r.archivePath ?? "(none)"})\n`
      );
    }
  }
}

async function main() {
  const config = resolveRunConfig();
  if (config.help) {
    return;
  }
  const { args, steps, ctx } = config;

  printRunBanner(args, ctx, steps);

  const overallStart = Date.now();
  const { results, firstFailure } = await executeSteps(args, ctx, steps);

  const totalMs = Date.now() - overallStart;
  printSummary(args, results, totalMs);

  if (firstFailure) {
    process.exit(firstFailure.outcome.code === 0 ? 1 : firstFailure.outcome.code);
  }
  if (args.dryRun) {
    process.stdout.write(`dry-run complete; no benches executed\n`);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    process.stderr.write(
      `run-full-bench-v0311: ${err instanceof Error ? err.stack : String(err)}\n`
    );
    process.exit(1);
  });
}
