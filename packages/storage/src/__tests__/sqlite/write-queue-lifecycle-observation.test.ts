import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createSerialSqliteWriteQueuePort } from "../../sqlite/write-queue/port.js";
import { createWorkerThreadSqliteWriteQueuePort } from "../../sqlite/write-queue/worker-port.js";
import { currentSqliteWriteQueueTermination, observeSqliteWriteQueueLifecycle, type QueueLifecycleSnapshot } from "../../sqlite/write-queue/lifecycle-observation.js";

async function persistenceScenario(observe: boolean, brokenObserver = false) {
  const root = mkdtempSync(join(tmpdir(), "queue-observation-"));
  const snapshots: QueueLifecycleSnapshot[] = [];
  const unsubscribe = observe ? observeSqliteWriteQueueLifecycle(snapshot => {
    snapshots.push(snapshot);
    if (brokenObserver) {
      if (snapshots.length % 2) throw new Error("observer failed");
      return Promise.reject(new Error("async observer failed"));
    }
  }) : () => undefined;
  const queue = createWorkerThreadSqliteWriteQueuePort();
  const filename = join(root, "probe.db");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let callerCompleted = false;
  try {
    const caller = queue.enqueue({ jobId: "caller", kind: "maintenance", filename,
      execute: async () => { await gate; callerCompleted = true; } });
    await Promise.resolve(); await Promise.resolve();
    const pendingSnapshot = snapshots.at(-1);
    const payload = queue.enqueue({ jobId: "persist", kind: "maintenance", filename,
      payload: { statements: [{ sql: "CREATE TABLE proof(value INTEGER)" }, { sql: "INSERT INTO proof VALUES (42)" }] } });
    const rejected = queue.enqueue({ jobId: "reject", kind: "maintenance", filename,
      execute: () => { throw new Error("job rejection"); } }).catch(error => error.message);
    const first = queue.close!(), second = queue.close!();
    expect(callerCompleted).toBe(false);
    release();
    await caller; await payload;
    const rejection = await rejected;
    await Promise.all([first, second]);
    await queue.close!();
    await expect(queue.enqueue({ jobId: "late", kind: "maintenance", filename })).rejects.toThrow("closed");
    const db = new Database(filename, { readonly: true });
    const persisted = db.prepare("SELECT value FROM proof").all(); db.close();
    return { result: { persisted, rejection, pending: queue.pendingCount(), callerCompleted }, snapshots, pendingSnapshot };
  } finally { release(); await queue.close!(); unsubscribe(); rmSync(root, { recursive: true, force: true }); }
}

describe("private SQLite queue lifecycle observation", () => {
  it("rejects payload and settles shutdown after a ready worker exits before another request", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-exited-"));
    const path = join(root, "worker.mjs");
    writeFileSync(path, "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({type:'ready'}); process.exit(0);");
    let exited!: () => void;
    const terminal = new Promise<void>(resolve => { exited = resolve; });
    const unsubscribe = observeSqliteWriteQueueLifecycle(row => { if (row.terminal !== null) exited(); });
    const queue = createWorkerThreadSqliteWriteQueuePort({ workerUrl: pathToFileURL(path) });
    try {
      await terminal;
      await expect(queue.enqueue({ jobId: "after-exit", kind: "maintenance", filename: join(root, "missing.db"),
        payload: { statements: [{ sql: "CREATE TABLE proof(value INTEGER)" }] } })).rejects.toThrow(/exited unexpectedly/u);
      await expect(queue.close!()).resolves.toBeUndefined();
    } finally { await queue.close!(); unsubscribe(); rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves real persistence, failed-work drain, caller jobs and concurrent/repeated close with observation off/on/erroring", async () => {
    const off = await persistenceScenario(false);
    const on = await persistenceScenario(true);
    const broken = await persistenceScenario(true, true);
    expect(off.snapshots).toEqual([]);
    expect(on.result).toEqual(off.result); expect(broken.result).toEqual(off.result);
    expect(on.result).toEqual({ persisted: [{ value: 42 }], rejection: "job rejection", pending: 0, callerCompleted: true });
    expect(on.pendingSnapshot).toMatchObject({ activeJob: "caller", pendingJobs: 1 });
    expect(on.snapshots[0]).toMatchObject({ readiness: "pending", terminal: null });
    const terminal = on.snapshots.at(-1)!;
    expect(terminal).toMatchObject({ accepting: false, pendingJobs: 0, activeJob: null,
      completedJobs: 2, failedJobs: 1, readiness: "ready", pendingRequests: 0 });
    expect(terminal.terminal).not.toBeNull();
    expect(terminal.closes).toHaveLength(4);
    expect(terminal.closes.every(row => row.drained && row.result === "fulfilled")).toBe(true);
    // Concurrent callers share the native shutdown; one cannot terminate another's waiter.
    expect(terminal.shutdowns).toHaveLength(1);
    expect(terminal.shutdowns.map(row => row.closeId)).toEqual([1]);
    expect(terminal.shutdowns.every(row => row.result === "acknowledged" && row.terminationRequested)).toBe(true);
    expect(Object.isFrozen(terminal)).toBe(true);
    expect(Object.isFrozen(terminal.shutdowns[0])).toBe(true);
    expect(on.snapshots[0]!.closes).toEqual([]);
    expect(currentSqliteWriteQueueTermination(terminal.threadId!)).toBeNull();
  });

  it("retains close rejection without converting a drained queue into successful teardown", async () => {
    const snapshots: QueueLifecycleSnapshot[] = [];
    const unsubscribe = observeSqliteWriteQueueLifecycle(row => { snapshots.push(row); });
    const error = new Error("teardown failed");
    const queue = createSerialSqliteWriteQueuePort({ kind: "test", runJob: async () => undefined,
      close: async () => { throw error; } });
    try {
      await expect(queue.close!()).rejects.toBe(error);
      expect(snapshots.at(-1)?.closes).toEqual([{ id: 1, drained: true, result: "rejected" }]);
    } finally { unsubscribe(); }
  });

  it.each(["rejected", "missing", "unready"] as const)("does not certify %s shutdown even when close resolves", async mode => {
    const root = mkdtempSync(join(tmpdir(), "queue-shutdown-"));
    const path = join(root, "worker.mjs");
    writeFileSync(path, `import { parentPort } from 'node:worker_threads';
      ${mode === "unready" ? "process.exit(0);" : `parentPort.postMessage({type:'ready'});
      parentPort.on('message', m => {
        ${mode === "missing" ? "process.exit(0);" : "parentPort.postMessage({type:'result',requestId:m.requestId,ok:false,error:'shutdown rejected'});"}
      });`}`);
    const snapshots: QueueLifecycleSnapshot[] = [];
    const unsubscribe = observeSqliteWriteQueueLifecycle(row => { snapshots.push(row); });
    const queue = createWorkerThreadSqliteWriteQueuePort({ workerUrl: pathToFileURL(path) });
    try {
      await expect(queue.close!()).resolves.toBeUndefined();
      const last = snapshots.at(-1)!;
      expect(last.closes[0]).toMatchObject({ drained: true, result: "fulfilled" });
      expect(last.shutdowns[0]).toMatchObject({ result: "failed", terminationRequested: true, pendingBeforeTerminate: 0 });
      expect(last.terminal).not.toBeNull();
      expect(last.readiness).toBe(mode === "unready" ? "failed" : "ready");
      expect(last.completedJobs).toBe(0);
      expect(snapshots.some(row => row.shutdowns[0]?.result === "pending")).toBe(true);
      if (mode !== "unready") expect(snapshots.some(row => row.pendingRequests === 1)).toBe(true);
    } finally { await queue.close!(); unsubscribe(); rmSync(root, { recursive: true, force: true }); }
  });
});
