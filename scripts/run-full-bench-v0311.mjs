#!/usr/bin/env node
// Orchestrates the v0.3.11 ship-gate full-bench wave (K1.1 + K1.4).
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
// Ship-gate matrix (docs/handbook/release/v0.3.11/kpi-targets.md, Tier-1):
//   K1.1  longmemeval-s   embedding=disabled         policy=chat  -> R@5 >= 90%
//   K1.4  locomo          embedding=disabled         policy=chat  -> R@5 >= 55%
//
// K1.2 (lme-mt), K1.3 (lme-cq), K1.5 (locomo-on) are deferred to a later
// v0.3.11 wave and are not orchestrated by this script.
//
// Each step writes its archive under the matching docs/bench-history/<root>/
// subtree; the script verifies a fresh archive slug appeared and contains
// kpi.json before continuing.
//
// Usage:
//   set -a; . .do-it/bench-env/alaya-api.env; set +a
//   node scripts/run-full-bench-v0311.mjs                        # both benches
//   node scripts/run-full-bench-v0311.mjs --bench lme-s          # single bench id
//   node scripts/run-full-bench-v0311.mjs --bench lme-s,locomo-off  # comma list
//   node scripts/run-full-bench-v0311.mjs --policy-shape stress  # override (default chat)
//   node scripts/run-full-bench-v0311.mjs --limit 50             # smoke; not release-grade
//   node scripts/run-full-bench-v0311.mjs --data-dir /tmp/bench  # override dataset root
//                                                                # (default: apps/bench-runner/data)
//   node scripts/run-full-bench-v0311.mjs --history-root <path>  # override archive root
//   node scripts/run-full-bench-v0311.mjs --dry-run              # print commands only
//   node scripts/run-full-bench-v0311.mjs --resume               # skip benches already done
//   node scripts/run-full-bench-v0311.mjs --help
//
// Detached operator launch:
//   setsid node scripts/run-full-bench-v0311.mjs \
//     > /tmp/v0311-full.log 2>&1 < /dev/null &
//   disown
//
// Resume semantics: --resume uses a per-step sentinel under <log-root>/<id>.done.
// Per-question intra-step resume (skip already-completed questions inside a
// single bench) is NOT implemented; if a 500Q LongMemEval run crashes midway
// the entire step re-runs. See unknowns in the worker return for follow-up.
//
// Exit codes:
//   0  every requested bench produced a fresh archive with kpi.json
//   1  one bench exited non-zero, or archive verification failed
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

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_HISTORY_ROOT = path.join(REPO_ROOT, "docs/bench-history");
const LOG_ROOT = path.join(REPO_ROOT, "var/bench-logs/v0.3.11");
const BENCH_RUNNER = path.join(
  REPO_ROOT,
  "apps/bench-runner/bin/alaya-bench-runner.mjs"
);
const GARDEN_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";
const BENCH_ENV_SOURCE_COMMAND =
  "set -a; . .do-it/bench-env/alaya-api.env; set +a";
const EXTRACTION_CACHE_MANIFEST_PATH = path.join(
  REPO_ROOT,
  "docs/bench-history/datasets/longmemeval-extraction-cache/manifest.json"
);

// Run-start env guard. A detached spawn (setsid / cron) inherits a clean env
// where OFFICIAL_API_GARDEN_MODEL may be unset; the bench then silently falls
// back to the production constant, misses every cache key, and degrades to a
// full live extraction that looks like a slow run rather than an error. Fail
// fast in the orchestrator with the exact source command, and when a cache
// manifest exists, name the model the cache was built with so a stale env is
// caught too.
function assertGardenModelEnv() {
  const present =
    typeof process.env[GARDEN_MODEL_ENV] === "string" &&
    process.env[GARDEN_MODEL_ENV].trim().length > 0;
  const manifestModel = readManifestExtractionModel();
  if (!present) {
    const detail =
      manifestModel === null
        ? ""
        : ` The committed extraction cache was built with ${GARDEN_MODEL_ENV}=${manifestModel}.`;
    throw new Error(
      `${GARDEN_MODEL_ENV} is not set; a detached bench spawn would ` +
        "silently fall back to the production model, miss every cache key, " +
        `and live-extract the full dataset (~466h).${detail} Source the bench ` +
        `env before launching: ${BENCH_ENV_SOURCE_COMMAND}`
    );
  }
  if (
    manifestModel !== null &&
    process.env[GARDEN_MODEL_ENV].trim() !== manifestModel
  ) {
    throw new Error(
      `${GARDEN_MODEL_ENV}=${process.env[GARDEN_MODEL_ENV]} does not match ` +
        `the extraction cache manifest model ${manifestModel}; the cache ` +
        "would miss every key and this run would live-extract (~466h). " +
        `Set ${GARDEN_MODEL_ENV}=${manifestModel} or rebuild the cache.`
    );
  }
}

function readManifestExtractionModel() {
  if (!existsSync(EXTRACTION_CACHE_MANIFEST_PATH)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(EXTRACTION_CACHE_MANIFEST_PATH, "utf8")
    );
    const model = parsed?.extraction_model;
    return typeof model === "string" && model.trim().length > 0 ? model : null;
  } catch {
    return null;
  }
}

// id is the short selector for --bench; archiveRoot is the bench-history
// subdirectory the harness writes to.
const BENCH_STEPS = [
  {
    id: "lme-s",
    label: "K1.1 LongMemEval-S embedding-off",
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
    label: "K1.4 LoCoMo embedding-off",
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

const HELP_TEXT = `run-full-bench-v0311 — sequential v0.3.11 ship-gate orchestrator

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
  --history-root <path>    Archive root (default: <repo>/docs/bench-history)
  --log-root <path>        Log root (default: <repo>/var/bench-logs/v0.3.11)
  --dry-run                Print commands without executing
  --resume                 Skip benches whose sentinel marker already exists
  --help                   Show this help

Exit codes:
  0  all requested benches completed and archived
  1  one bench failed or archive verification failed
  2  bad CLI argument
`;

function parseArgs(argv) {
  const args = {
    benches: undefined,
    policyShape: "chat",
    limit: undefined,
    dataDir: undefined,
    historyRoot: DEFAULT_HISTORY_ROOT,
    logRoot: LOG_ROOT,
    dryRun: false,
    resume: false
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--bench") {
      args.benches = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (token === "--policy-shape") {
      args.policyShape = argv[++i] ?? args.policyShape;
    } else if (token === "--limit") {
      const raw = argv[++i];
      const parsed = Number.parseInt(raw ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--limit requires positive integer, got '${raw}'`);
      }
      args.limit = parsed;
    } else if (token === "--data-dir") {
      args.dataDir = argv[++i];
    } else if (token === "--history-root") {
      args.historyRoot = path.resolve(argv[++i] ?? args.historyRoot);
    } else if (token === "--log-root") {
      args.logRoot = path.resolve(argv[++i] ?? args.logRoot);
    } else if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--resume") {
      args.resume = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

function selectSteps(ids) {
  if (!ids || ids.length === 0) return BENCH_STEPS;
  const known = new Map(BENCH_STEPS.map((s) => [s.id, s]));
  const picked = [];
  for (const id of ids) {
    const step = known.get(id);
    if (!step) {
      throw new Error(
        `unknown bench id '${id}'. valid: ${BENCH_STEPS.map((s) => s.id).join(", ")}`
      );
    }
    picked.push(step);
  }
  return picked;
}

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

function buildContext(args) {
  const dataDir =
    args.dataDir ??
    process.env.ALAYA_BENCH_DATA_DIR ??
    path.join(REPO_ROOT, "apps/bench-runner/data");
  return {
    policyShape: args.policyShape,
    limit: args.limit,
    dataDir: path.resolve(dataDir),
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
        env: process.env,
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
  const kpiPath = archivePath ? path.join(archivePath, "kpi.json") : null;
  const archiveOk =
    archivePath !== null && kpiPath !== null && existsSync(kpiPath);

  if (code === 0 && archiveOk) {
    writeFileSync(
      sentinelPath(args.logRoot, step.id),
      JSON.stringify(
        {
          step_id: step.id,
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

function formatDuration(ms) {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m${sec}s`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`run-full-bench-v0311: ${err.message}\n`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  let steps;
  try {
    steps = selectSteps(args.benches);
  } catch (err) {
    process.stderr.write(`run-full-bench-v0311: ${err.message}\n`);
    process.exit(2);
  }

  const ctx = buildContext(args);

  // Fail fast before any detached spawn: a clean inherited env must not
  // silently fall back to the production model and live-extract the full
  // dataset. --dry-run only prints commands, so it skips the live-env guard.
  if (!args.dryRun) {
    try {
      assertGardenModelEnv();
    } catch (err) {
      process.stderr.write(`run-full-bench-v0311: ${err.message}\n`);
      process.exit(2);
    }
  }

  process.stdout.write(`run-full-bench-v0311 starting\n`);
  process.stdout.write(`  repo_root=${REPO_ROOT}\n`);
  process.stdout.write(`  data_dir=${ctx.dataDir}\n`);
  process.stdout.write(`  history_root=${ctx.historyRoot}\n`);
  process.stdout.write(`  log_root=${args.logRoot}\n`);
  process.stdout.write(`  policy_shape=${ctx.policyShape}\n`);
  process.stdout.write(`  limit=${ctx.limit ?? "(none / full set)"}\n`);
  process.stdout.write(`  dry_run=${args.dryRun}\n`);
  process.stdout.write(`  resume=${args.resume}\n`);
  process.stdout.write(`  steps=${steps.map((s) => s.id).join(",")}\n`);

  const results = [];
  const overallStart = Date.now();
  let firstFailure = null;

  for (const step of steps) {
    const sentinel = sentinelPath(args.logRoot, step.id);
    if (args.resume && existsSync(sentinel)) {
      process.stdout.write(
        `\n=== ${step.label} ===\nSKIP (resume sentinel present: ${sentinel})\n`
      );
      results.push({
        step,
        skipped: true,
        ok: true,
        code: 0,
        durationMs: 0,
        archivePath: null,
        logPath: null
      });
      continue;
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

  const totalMs = Date.now() - overallStart;
  process.stdout.write(`\n=== summary ===\n`);
  process.stdout.write(`total_wall_clock=${formatDuration(totalMs)}\n`);
  for (const r of results) {
    if (r.skipped) {
      process.stdout.write(
        `  ${r.step.id}: SKIP (resume)\n`
      );
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
