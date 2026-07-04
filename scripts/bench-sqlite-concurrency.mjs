#!/usr/bin/env node
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { measureSqliteBlockingOnEventLoop } from "../packages/storage/dist/diagnostics/sqlite-blocking-probe.js";

const outDir = join(process.cwd(), ".do-it/bench-runs");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const outPath = join(outDir, `sqlite-concurrency-${stamp}.json`);

const root = mkdtempSync(join(tmpdir(), "alaya-sqlite-bench-"));
const db = new Database(join(root, "bench.db"));
db.exec("CREATE TABLE bench (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
const insert = db.prepare("INSERT INTO bench (payload) VALUES (?)");
const select = db.prepare("SELECT COUNT(*) AS count FROM bench");
for (let index = 0; index < 500; index += 1) {
  insert.run(`seed-${index}`);
}

const result = measureSqliteBlockingOnEventLoop({
  runSyncWork: () => {
    db.transaction(() => {
      for (let index = 0; index < 100; index += 1) {
        insert.run(`sync-${index}`);
      }
    })();
  },
  runInterleavedRead: () => {
    select.get();
  }
});

db.close();

const payload = {
  captured_at: new Date().toISOString(),
  driver: "scripts/bench-sqlite-concurrency.mjs",
  sqlite_driver: "better-sqlite3@12.9.0 (sync, main-thread)",
  recommendation:
    "Defer async SQLite wrapper until worker-thread queue design preserves EventLog-first transaction semantics.",
  research_gap:
    "No research-first comparison recorded for sql.js / @sqlite.org/sqlite-wasm / custom worker queue vs status quo.",
  result: {
    sync_work_duration_ms: result.syncWorkDurationMs,
    max_event_loop_delay_ms: result.maxEventLoopDelayMs,
    baseline_read_p99_ms: result.baselineReadP99Ms,
    interleaved_read_p99_ms: result.interleavedReadP99Ms,
    interleaved_read_samples_ms: result.interleavedReadSamplesMs,
    blocking_ratio_p99: result.blockingRatioP99
  }
};

writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
process.stdout.write(`${outPath}\n`);
