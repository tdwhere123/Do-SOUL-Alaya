import { afterAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { initDatabase } from "@do-soul/alaya-storage";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { conditionalRecallPayload, persistConditionalSource } from "../field/query-only-hydration-fixture.js";
import { seedWorkspace, seedRun } from "../field/source-field-harness.js";
import { assertBuiltWorker } from "./recall-read-worker-client-fixture.js";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";

afterAll(() => boundary.restore());
const output = process.env.ALAYA_RETENTION_PROFILE_OUTPUT;
type Row = { kind: string; at: number; ok?: boolean; memory: NodeJS.MemoryUsage;
  accounting?: { retained_bytes: number; entries: number; executions: number };
  event?: { reason: string }; violations?: string[] };

// Opt-in physical measurement: run only in the serialized local heavy slot.
it.skipIf(!output)("profiles real SQLite recall retention, idle expiry and worker exit", async () => {
  assertBuiltWorker();
  mkdirSync(output!, { recursive: true });
  writeFileSync(join(output!, "workload.json"), JSON.stringify({
    sourceCount: 1, workers: 1, queries: 2, query: "needle", pageBudget: 100,
    admittedLifetimeMs: 2000, idleMs: 2500, sampleIntervalMs: 25,
    cold: "first query after Worker ready; not OS-cache cold", warm: "second identical query in same Worker",
    ttl: "production five-minute ceiling unchanged; request explicitly admits two seconds",
    instrumentation: "Worker heapUsed and process-wide RSS; interval sampling misses synchronous peaks; no forced GC",
    scope: "synthetic provider-free source fixture; no inference, benchmark cache or capacity-policy change",
    notMeasured: ["per-worker RSS", "absolute peak", "production-load p95", "socket shutdown", "RSS guarantee"]
  }, null, 2));
  const root = mkdtempSync(join(tmpdir(), "alaya-retention-profile-"));
  const filename = join(root, "alaya.db");
  const database = initDatabase({ filename });
  const workers = new Set<Worker>(), exits: number[] = [];
  const post = Worker.prototype.postMessage;
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
    if (!workers.has(this)) {
      workers.add(this);
      this.once("exit", code => exits.push(code));
    }
    return Reflect.apply(post, this, args);
  });
  let client: ReturnType<typeof createRecallReadWorkerClient> = null;
  const stages: unknown[] = [];
  const rows = (): Row[] => readFileSync(`${filename}.profile.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const mark = (phase: string) => stages.push({ phase, at: performance.now(), parentMemory: process.memoryUsage() });
  try {
    seedWorkspace(database); seedRun(database);
    await persistConditionalSource(database, "00000000-0000-4000-8000-000000000001", "needle independent worker source");
    database.close();
    expect(database.isClosed()).toBe(true);
    mark("baseline");
    client = createRecallReadWorkerClient({ databaseFilename: filename,
      workerUrl: new URL("./recall-retention-profile-worker-fixture.mjs", import.meta.url),
      workerCount: 1, requestTimeoutMs: 20_000 });
    await client!.ready();
    mark("ready");
    const base = conditionalRecallPayload("needle");
    const request = { ...base, result_kind_view: "source_only" as const,
      budget: { ...base.budget, page_budget: 100 },
      expires_at: new Date(Date.parse(base.lifetime_now) + 2000).toISOString() };
    const port = client!.conditionalFieldPort;
    const coldStart = performance.now();
    const cold = await port.recall(request);
    stages.push({ phase: "cold", durationMs: performance.now() - coldStart, index: cold.index });
    await port.acknowledge!(cold.preparation_id!, cold.index, new Map(Object.entries(cold.previews)));
    const warmStart = performance.now();
    const warm = await port.recall(request);
    stages.push({ phase: "warm", durationMs: performance.now() - warmStart, index: warm.index });
    expect(cold.index.entries.length).toBeGreaterThan(0);
    expect(warm.index.entries).toEqual(cold.index.entries);
    expect(warm.index.completeness).toEqual(cold.index.completeness);
    expect(warm.previews).toEqual(cold.previews);
    await port.acknowledge!(warm.preparation_id!, warm.index, new Map(Object.entries(warm.previews)));
    const active = rows().filter(row => row.kind === "response").at(-1)!;
    expect(active.accounting!.retained_bytes).toBeGreaterThan(0);
    mark("active");
    const idleStart = rows().length;
    // No RPC, snapshot, token lookup or fake clock during this bounded idle interval.
    await new Promise(resolve => setTimeout(resolve, 2500));
    const idle = rows().slice(idleStart);
    expect(idle.some(row => row.event?.reason === "expired")).toBe(true);
    expect(idle.some(row => row.kind === "response")).toBe(false);
    mark("idle");
    stages.push({ phase: "idle-worker", sample: idle.at(-1) });
    await expect(port.acknowledge!(warm.preparation_id!, warm.index,
      new Map(Object.entries(warm.previews)))).rejects.toThrow("Recall delivery worker unavailable");
    // A read RPC observes accounting only AFTER independent active-timer evidence.
    await client!.memoryRepo.findByWorkspaceId(request.workspace_id);
    expect(rows().filter(row => row.kind === "response").at(-1)!.accounting)
      .toEqual({ entries: 0, executions: 0, retained_bytes: 0 });
    await client!.close();
    expect(exits).toHaveLength(1);
    expect([...workers].every(worker => worker.threadId === -1)).toBe(true);
    mark("closed");
    expect(boundary.violations).toEqual([]);
    expect(rows().flatMap(row => row.violations ?? [])).toEqual([]);
  } finally {
    await client?.close();
    spy.mockRestore();
    if (!database.isClosed()) database.close();
    if (existsSync(`${filename}.profile.jsonl`)) {
      const samples = rows();
      writeFileSync(join(output!, "worker.jsonl"), readFileSync(`${filename}.profile.jsonl`));
      writeFileSync(join(output!, "observations.json"), JSON.stringify({ stages, exits,
        sampledPeakWorkerHeapUsed: Math.max(...samples.map(row => row.memory.heapUsed)),
        sampledPeakProcessRss: Math.max(...samples.map(row => row.memory.rss)),
        lastWorkerSample: samples.at(-1),
        note: "Closed worker heap is unavailable, not zero. Parent closed RSS includes the test runner. Client close terminates the Worker and awaits actual exit; explicit SQLite close callback and OS handle tracing are NOT_CHECKED."
      }, null, 2));
    }
    removeTempDirectorySync(root);
  }
}, 30_000);
