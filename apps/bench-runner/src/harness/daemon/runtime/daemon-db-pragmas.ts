import { statSync } from "node:fs";
import { join } from "node:path";
import { hasEmbeddingOverlayBind, initDatabase } from "@do-soul/alaya-storage";
import { emitBenchHarnessWarning } from "./daemon-warnings.js";

const BENCH_FAST_PRAGMA_ENV = "ALAYA_BENCH_FAST_PRAGMA";
const BENCH_TEMP_STORE_ENV = "ALAYA_BENCH_TEMP_STORE";
const BENCH_CACHE_SIZE_KIB_ENV = "ALAYA_BENCH_CACHE_SIZE_KIB";

// Negative cache_size is KiB. Floor keeps small DBs at the historical 64 MiB
// working set; cap stops a multi-GB snapshot from pinning the whole file.
const CACHE_FLOOR_KIB = 65_536;
const CACHE_CAP_KIB = 1_048_576;

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

function readDbFileBytes(filename: string): number {
  try {
    const size = statSync(filename).size;
    return Number.isFinite(size) && size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

function readBenchCacheSizeOverrideKib(): number | undefined {
  const raw = process.env[BENCH_CACHE_SIZE_KIB_ENV];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const kib = Number(trimmed);
  if (!Number.isSafeInteger(kib) || kib <= 0) return undefined;
  return kib;
}

function resolveBenchCacheSizeKib(fileBytes: number): number {
  const override = readBenchCacheSizeOverrideKib();
  if (override !== undefined) return override;
  const quarterKib = Math.floor(fileBytes / 4 / 1024);
  return Math.min(CACHE_CAP_KIB, Math.max(CACHE_FLOOR_KIB, quarterKib));
}

// Tiny DBs leave mmap at SQLite's default. Large working copies set mmap_size=0:
// WSL2 SIGBUS'd a long-lived pager that mmap'd a multi-GB working copy.
function resolveBenchMmapSize(fileBytes: number, workingDbPath: string): number | undefined {
  if (hasEmbeddingOverlayBind(workingDbPath)) return 0;
  if (fileBytes < CACHE_FLOOR_KIB * 1024) return undefined;
  return 0;
}

function benchPragmaList(
  tempStore: "FILE" | "MEMORY",
  cacheKib: number,
  mmapSize: number | undefined
): readonly string[] {
  const pragmas = [
    "journal_mode=WAL",
    "synchronous=NORMAL",
    `temp_store=${tempStore}`,
    `cache_size=-${cacheKib}`
  ];
  if (mmapSize !== undefined) pragmas.push(`mmap_size=${mmapSize}`);
  return Object.freeze(pragmas);
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

// Slice install may close the cached handle; reopen so prepared statements
// bind the current alaya.db inode instead of a renamed packed copy.
export function reloadBenchWorkingDatabase(dataDir: string): void {
  const live = initDatabase({ filename: join(dataDir, "alaya.db") });
  live.reopenIfClosed();
  applyBenchFastPragmaIfRequested(dataDir);
  optimizeBenchDb(dataDir);
  live.connection.exec("ANALYZE");
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
  const workingDbPath = join(dataDir, "alaya.db");
  const db = initDatabase({ filename: workingDbPath });
  const conn = db.connection;
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  const tempStore = resolveBenchTempStore();
  conn.pragma(`temp_store = ${tempStore}`);
  const fileBytes = readDbFileBytes(workingDbPath);
  const cacheKib = resolveBenchCacheSizeKib(fileBytes);
  conn.pragma(`cache_size = -${cacheKib}`);
  const mmapSize = resolveBenchMmapSize(fileBytes, workingDbPath);
  if (mmapSize !== undefined) {
    conn.pragma(`mmap_size = ${mmapSize}`);
  }
  return Object.freeze({
    applied: true,
    pragmas: benchPragmaList(tempStore, cacheKib, mmapSize)
  });
}
