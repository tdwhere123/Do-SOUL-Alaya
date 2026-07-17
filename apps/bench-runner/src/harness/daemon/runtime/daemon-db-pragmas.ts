import { join } from "node:path";
import { initDatabase } from "@do-soul/alaya-storage";
import { emitBenchHarnessWarning } from "./daemon-warnings.js";

const BENCH_FAST_PRAGMA_ENV = "ALAYA_BENCH_FAST_PRAGMA";
const BENCH_TEMP_STORE_ENV = "ALAYA_BENCH_TEMP_STORE";

function isBenchFastPragmaEnabled(): boolean {
  const raw = process.env[BENCH_FAST_PRAGMA_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "off" &&
    normalized !== "no"
  );
}

// FILE by default so temp B-trees spill to disk and do not feed RSS toward the
// OS OOM-killer on long single-process runs. ALAYA_BENCH_TEMP_STORE=memory opts
// back into the throughput-favoring RAM temp store for short runs.
function resolveBenchTempStore(): "FILE" | "MEMORY" {
  const raw = process.env[BENCH_TEMP_STORE_ENV];
  return raw !== undefined && raw.trim().toLowerCase() === "memory"
    ? "MEMORY"
    : "FILE";
}

export interface BenchFastPragmaResult {
  readonly applied: boolean;
  readonly pragmas: readonly string[];
}

// Refresh SQLite query-planner stats on the daemon's live connection (initDatabase
// caches by path) so workspace-scoped recall keeps the workspace_id index instead
// of near-full-scanning the growing shared bench DB. Best-effort.
export function optimizeBenchDb(dataDir: string): void {
  try {
    initDatabase({ filename: join(dataDir, "alaya.db") }).optimize();
  } catch (error) {
    emitBenchHarnessWarning("ALAYA_BENCH_DB_OPTIMIZE_FAILED", "sqlite_optimize", error, { data_dir: dataDir });
  }
}

export function applyBenchFastPragmaIfRequested(
  dataDir: string
): BenchFastPragmaResult {
  if (!isBenchFastPragmaEnabled()) {
    return Object.freeze({ applied: false, pragmas: Object.freeze([]) });
  }
  // initDatabase caches by path, so this returns the same connection the
  // daemon runtime is already using. The pragmas are session-scoped except
  // journal_mode (file-scoped + persisted) — re-issuing the production set
  // here is a no-op and documents the bench layering.
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const conn = db.connection;
  // Production-set pragmas (re-asserted defensively; safe no-op when already on).
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  // Bench-only adds.
  const tempStore = resolveBenchTempStore();
  conn.pragma(`temp_store = ${tempStore}`);
  conn.pragma("cache_size = -65536");
  return Object.freeze({
    applied: true,
    pragmas: Object.freeze([
      "journal_mode=WAL",
      "synchronous=NORMAL",
      `temp_store=${tempStore}`,
      "cache_size=-65536"
    ])
  });
}

