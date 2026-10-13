import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
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
    // Windows CI runners can spend well over 15s on this blocking probe under load.
  }, process.platform === "win32" ? 120_000 : 60_000);

  it.skipIf(process.platform === "win32")(
    "reads on the main thread during an active worker write transaction",
    async () => {
      const workerUrl = resolveSqliteWriteQueueWorkerUrl();
      expect(workerUrl).not.toBeNull();

      const root = mkdtempSync(join(tmpdir(), "alaya-sqlite-worker-tail-"));
      roots.push(root);
      const filename = join(root, "probe.db");
      const db = new Database(filename);
      let gate: Database.Database | undefined;
      let workerWrite: Promise<void> = Promise.resolve();
      try {
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 0");
        db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
        const insert = db.prepare("INSERT INTO probe (payload) VALUES (?)");
        const select = db.prepare("SELECT COUNT(*) AS count FROM probe");
        for (let index = 0; index < 200; index += 1) {
          insert.run(`seed-${index}`);
        }
        const heavyPayload = Object.freeze(
          Array.from({ length: 8_000 }, (_, index) => ({
            sql: "INSERT INTO probe (payload) VALUES (?)",
            params: [`worker-${index}-${"x".repeat(96)}`] as const
          }))
        );
        const gateFilename = join(root, "gate.db");
        gate = new Database(gateFilename);
        gate.pragma("journal_mode = WAL");
        gate.exec("CREATE TABLE gate (value INTEGER NOT NULL)");
        const queue = createWorkerThreadSqliteWriteQueuePort({ workerUrl: workerUrl! });
        queues.push(queue);
        let syncReadRan = false;
        const syncRead = nextTurn().then(() => {
          syncReadRan = true;
        });
        db.transaction(() => {
          for (const statement of heavyPayload) insert.run(...statement.params);
          expect(syncReadRan).toBe(false);
        })();
        await syncRead;
        expect(select.get()).toEqual({ count: 8_200 });
        db.prepare("DELETE FROM probe WHERE payload LIKE 'worker-%'").run();

        // The worker locks probe.db before waiting on this attached database.
        // Observing that lock proves SQL has started, not merely been enqueued.
        gate.exec("BEGIN IMMEDIATE");
        let workerSettled = false;
        workerWrite = queue.enqueue({
          jobId: "heavy-worker-write",
          kind: "maintenance",
          filename,
          payload: {
            statements: [
              { sql: "ATTACH DATABASE ? AS write_gate", params: [gateFilename] },
              { sql: "INSERT INTO write_gate.gate (value) VALUES (1)" },
              ...heavyPayload
            ]
          }
        });
        void workerWrite.then(
          () => { workerSettled = true; },
          () => { workerSettled = true; }
        );
        await expect.poll(() => isWriteLocked(db), { timeout: 5_000, interval: 10 }).toBe(true);
        await nextTurn();
        expect(select.get()).toEqual({ count: 200 });
        expect(isWriteLocked(db)).toBe(true);
        expect(workerSettled).toBe(false);
        gate.exec("ROLLBACK");

        // A worker failure must not masquerade as responsive off-thread work.
        await workerWrite;
        expect(select.get()).toEqual({ count: 8_200 });
        expect(gate.prepare("SELECT COUNT(*) AS count FROM gate").get()).toEqual({ count: 1 });
      } finally {
        if (gate?.inTransaction) gate.exec("ROLLBACK");
        await workerWrite.catch(() => undefined);
        gate?.close();
        db.close();
      }
    },
    60_000
  );
});

function isWriteLocked(db: Database.Database): boolean {
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") return true;
    throw error;
  }
}
