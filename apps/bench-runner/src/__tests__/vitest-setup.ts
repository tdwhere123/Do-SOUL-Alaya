import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, onTestFinished, vi } from "vitest";
import { bindBenchDaemonTestSignal, clearBenchDaemonTestSignal, settleActiveBenchDaemonTasks } from "../harness/daemon-task.js";

const PHASE_FILE = /(?:complete-query-fill|correspondence-fill-admission|retained-native-source-snapshot)\.test\.ts$/u;

beforeEach((context) => {
  bindBenchDaemonTestSignal(context.signal);
  const started = performance.now();
  const file = basename(context.task.file.filepath);
  if (PHASE_FILE.test(file)) {
    console.log(`[bench-phase] pid=${process.pid} event=start file=${file} test=${context.task.name}`);
  }
  onTestFinished(async () => {
    if (PHASE_FILE.test(file)) {
      const ms = Math.round(performance.now() - started);
      console.log(`[bench-phase] pid=${process.pid} event=end file=${file} ms=${ms} test=${context.task.name}`);
    }
    try {
      await settleActiveBenchDaemonTasks();
    } finally {
      clearBenchDaemonTestSignal(context.signal);
    }
  });
});

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (_host: string, options?: { all?: boolean }) => {
    const answer = { address: "93.184.216.34", family: 4 };
    return options?.all === true ? [answer] : answer;
  })
}));

// Unit tests use ephemeral temp cache roots with mock extractors; they are not
// cache-only bench runs and should not require a committed extraction manifest.
process.env.ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST = "0";
// Keep vitest runs off the operator's local LongMemEval extraction cache so
// preflight drift checks do not bind tests to a particular model/manifest.
process.env.ALAYA_BENCH_EXTRACTION_CACHE_ROOT = mkdtempSync(
  join(tmpdir(), "alaya-bench-vitest-cache-")
);
// Mock-extractor suites still resolve a complete cache identity. Keep that
// identity explicit and non-routable after production stopped guessing a URL.
process.env.OFFICIAL_API_GARDEN_PROVIDER_URL = "https://fixture-provider.invalid/v1";
