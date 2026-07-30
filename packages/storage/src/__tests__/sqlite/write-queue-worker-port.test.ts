import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  createWorkerThreadSqliteWriteQueuePort,
  resolveSqliteWriteQueueWorkerUrl
} from "../../sqlite/write-queue/worker-port.js";

describe("worker-thread SqliteWriteQueuePort", () => {
  const roots: string[] = [];
  const queues: Array<ReturnType<typeof createWorkerThreadSqliteWriteQueuePort>> = [];

  afterEach(async () => {
    while (queues.length > 0) {
      await queues.pop()?.close?.();
    }
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  function createQueue() {
    const workerUrl = resolveSqliteWriteQueueWorkerUrl();
    expect(workerUrl).not.toBeNull();
    const queue = createWorkerThreadSqliteWriteQueuePort({ workerUrl: workerUrl! });
    queues.push(queue);
    return queue;
  }

  function createProbeDb(): { readonly filename: string; readonly db: Database.Database } {
    const root = mkdtempSync(join(tmpdir(), "alaya-write-queue-worker-"));
    roots.push(root);
    const filename = join(root, "probe.db");
    const db = new Database(filename);
    db.pragma("journal_mode = WAL");
    db.exec(
      "CREATE TABLE probe (id INTEGER PRIMARY KEY, lane TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL)"
    );
    return { filename, db };
  }

  it("serializes payload jobs EventLog-first and blocks eviction while pending", async () => {
    const queue = createQueue();
    const { filename, db } = createProbeDb();

    const first = queue.enqueue({
      jobId: "event-1",
      kind: "event_log_transaction",
      filename,
      payload: {
        statements: [
          {
            sql: "INSERT INTO probe (lane, seq, payload) VALUES (?, ?, ?)",
            params: ["event", 1, "event-log"]
          }
        ]
      }
    });
    expect(queue.blocksEviction(filename)).toBe(true);

    const second = queue.enqueue({
      jobId: "onto-1",
      kind: "ontology_write",
      filename,
      payload: {
        statements: [
          {
            sql: "INSERT INTO probe (lane, seq, payload) VALUES (?, ?, ?)",
            params: ["onto", 2, "ontology"]
          }
        ]
      }
    });

    await first;
    await second;

    const rows = db.prepare("SELECT lane, seq FROM probe ORDER BY id ASC").all() as Array<{
      lane: string;
      seq: number;
    }>;
    expect(rows).toEqual([
      { lane: "event", seq: 1 },
      { lane: "onto", seq: 2 }
    ]);
    expect(queue.pendingCount()).toBe(0);
    expect(queue.blocksEviction(filename)).toBe(false);
    db.close();
  }, 60_000);

  it("rejects a failing payload job without poisoning later jobs", async () => {
    const queue = createQueue();
    const { filename, db } = createProbeDb();
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => process);

    const failing = queue.enqueue({
      jobId: "job-fail",
      kind: "ontology_write",
      filename,
      payload: {
        statements: [{ sql: "INSERT INTO missing_table (id) VALUES (1)" }]
      }
    });
    const succeeding = queue.enqueue({
      jobId: "job-ok",
      kind: "ontology_write",
      filename,
      payload: {
        statements: [
          {
            sql: "INSERT INTO probe (lane, seq, payload) VALUES (?, ?, ?)",
            params: ["ok", 1, "ok"]
          }
        ]
      }
    });

    await expect(failing).rejects.toThrow();
    await succeeding;

    const count = (
      db.prepare("SELECT COUNT(*) AS count FROM probe").get() as { count: number }
    ).count;
    expect(count).toBe(1);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringMatching(/SQLite write queue job failed \(jobId=job-fail/),
      expect.objectContaining({ code: "ALAYA_SQLITE_WRITE_QUEUE_JOB_FAILED" })
    );

    emitWarning.mockRestore();
    db.close();
  }, 60_000);

  it("keeps execute jobs on the caller thread inside the serial chain", async () => {
    const queue = createQueue();
    const filename = "/tmp/alaya/worker-execute-order.db";
    const order: string[] = [];

    await queue.enqueue({
      jobId: "event-exec",
      kind: "event_log_transaction",
      filename,
      execute: async () => {
        order.push("event");
      }
    });
    await queue.enqueue({
      jobId: "onto-exec",
      kind: "ontology_write",
      filename,
      execute: async () => {
        order.push("onto");
      }
    });

    expect(order).toEqual(["event", "onto"]);
  }, 60_000);

  it("drains an in-flight job through close and allows a second open", async () => {
    const queue = createQueue();
    const filename = "/tmp/alaya/worker-close-drain.db";
    let completed = false;
    let releaseSlowJob: (() => void) | undefined;
    const slowJobGate = new Promise<void>((resolve) => {
      releaseSlowJob = resolve;
    });

    const inflight = queue.enqueue({
      jobId: "inflight-close",
      kind: "event_log_transaction",
      filename,
      execute: async () => {
        await slowJobGate;
        completed = true;
      }
    });
    const closing = queue.close!();
    await Promise.resolve();
    expect(completed).toBe(false);
    releaseSlowJob?.();
    await expect(inflight).resolves.toBeUndefined();
    await closing;
    expect(completed).toBe(true);
    await expect(
      queue.enqueue({
        jobId: "after-close",
        kind: "maintenance",
        filename,
        execute: async () => undefined
      })
    ).rejects.toThrow(/closed/);

    const second = createQueue();
    const { filename: probeFilename, db } = createProbeDb();
    await second.enqueue({
      jobId: "second-open",
      kind: "ontology_write",
      filename: probeFilename,
      payload: {
        statements: [
          {
            sql: "INSERT INTO probe (lane, seq, payload) VALUES (?, ?, ?)",
            params: ["second", 1, "ok"]
          }
        ]
      }
    });
    const count = (
      db.prepare("SELECT COUNT(*) AS count FROM probe").get() as { count: number }
    ).count;
    expect(count).toBe(1);
    db.close();
  }, 60_000);

  it("replies ok:false for malformed requests that still carry requestId", async () => {
    const workerUrl = resolveSqliteWriteQueueWorkerUrl();
    expect(workerUrl).not.toBeNull();
    const { Worker } = await import("node:worker_threads");
    const worker = new Worker(workerUrl!);
    try {
      await new Promise<void>((resolve, reject) => {
        const onReady = (message: unknown) => {
          if (
            typeof message === "object" &&
            message !== null &&
            (message as { type?: unknown }).type === "ready"
          ) {
            worker.off("message", onReady);
            resolve();
          }
        };
        worker.on("message", onReady);
        worker.on("error", reject);
      });

      const result = new Promise<{ ok: boolean; requestId: number; error?: string }>((resolve, reject) => {
        worker.on("message", (message: unknown) => {
          if (
            typeof message === "object" &&
            message !== null &&
            (message as { type?: unknown }).type === "result"
          ) {
            resolve(message as { ok: boolean; requestId: number; error?: string });
          }
        });
        worker.on("error", reject);
      });

      worker.postMessage({ type: "run", requestId: 42, jobId: "bad" });
      await expect(result).resolves.toMatchObject({
        ok: false,
        requestId: 42,
        error: "malformed sqlite write queue request"
      });
    } finally {
      await worker.terminate();
    }
  }, 60_000);
});
