import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { measureSqliteBlockingOnEventLoop } from "../../diagnostics/sqlite-blocking-probe.js";
import {
  createWorkerThreadSqliteWriteQueuePort,
  resolveSqliteWriteQueueWorkerUrl
} from "../../sqlite/write-queue/worker-port.js";

describe("concurrent sqlite tail latency", () => {
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

  it("shows interleaved read tail inflation while sync work runs", () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-sqlite-tail-"));
    roots.push(root);
    const db = new Database(join(root, "probe.db"));
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO probe (payload) VALUES (?)");
    const select = db.prepare("SELECT COUNT(*) AS count FROM probe");
    for (let index = 0; index < 200; index += 1) {
      insert.run(`payload-${index}`);
    }

    const result = measureSqliteBlockingOnEventLoop({
      runSyncWork: () => {
        db.transaction(() => {
          for (let index = 0; index < 50; index += 1) {
            insert.run(`sync-${index}`);
          }
        })();
      },
      runInterleavedRead: () => {
        select.get();
      },
      sampleCount: 16
    });

    expect(result.syncWorkDurationMs).toBeGreaterThan(0);
    expect(result.interleavedReadSamplesMs.length).toBe(16);
    expect(Number.isFinite(result.blockingRatioP99)).toBe(true);
    db.close();
    // Windows CI runners can spend >15s on this blocking probe under load.
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "worker payload writes leave the main-thread event loop responsive vs sync writes",
    async () => {
    const workerUrl = resolveSqliteWriteQueueWorkerUrl();
    expect(workerUrl).not.toBeNull();

    const root = mkdtempSync(join(tmpdir(), "alaya-sqlite-worker-tail-"));
    roots.push(root);
    const filename = join(root, "probe.db");
    const db = new Database(filename);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO probe (payload) VALUES (?)");
    const select = db.prepare("SELECT COUNT(*) AS count FROM probe");
    for (let index = 0; index < 200; index += 1) {
      insert.run(`seed-${index}`);
    }

    // Floor the sync block so fast hosts still show event-loop stall vs worker offload.
    const syncBlockMs = 40;
    const heavyPayload = Object.freeze(
      Array.from({ length: 8_000 }, (_, index) => ({
        sql: "INSERT INTO probe (payload) VALUES (?)",
        params: [`worker-${index}-${"x".repeat(96)}`] as const
      }))
    );

    const syncFirstReadDelayMs = await measureFirstReadDelayAfterKickoff({
      kickoff: () => {
        const deadline = performance.now() + syncBlockMs;
        db.transaction(() => {
          let index = 0;
          while (performance.now() < deadline) {
            insert.run(`sync-${index}-${"x".repeat(96)}`);
            index += 1;
          }
        })();
      },
      runRead: () => {
        select.get();
      }
    });

    const queue = createWorkerThreadSqliteWriteQueuePort({ workerUrl: workerUrl! });
    queues.push(queue);

    let workerWrite: Promise<void> = Promise.resolve();
    try {
      const workerFirstReadDelayMs = await measureFirstReadDelayAfterKickoff({
        kickoff: () => {
          workerWrite = queue.enqueue({
            jobId: "heavy-worker-write",
            kind: "maintenance",
            filename,
            payload: { statements: heavyPayload }
          });
        },
        runRead: () => {
          select.get();
        }
      });

      // Sync path blocks the event loop for the whole write; worker path schedules the
      // first main-thread read while the write runs off-thread.
      expect(syncFirstReadDelayMs).toBeGreaterThan(syncBlockMs * 0.8);
      expect(workerFirstReadDelayMs).toBeLessThan(syncFirstReadDelayMs);
      expect(workerFirstReadDelayMs).toBeLessThan(500);
    } finally {
      await workerWrite.catch(() => undefined);
      db.close();
    }
  }, 60_000);
});

async function measureFirstReadDelayAfterKickoff(input: {
  readonly kickoff: () => void;
  readonly runRead: () => void;
}): Promise<number> {
  const start = performance.now();
  const firstReadDelay = new Promise<number>((resolve) => {
    setImmediate(() => {
      input.runRead();
      resolve(performance.now() - start);
    });
  });
  input.kickoff();
  return await firstReadDelay;
}
