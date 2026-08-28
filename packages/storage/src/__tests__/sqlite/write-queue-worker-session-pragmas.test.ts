import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  configureSqliteWriteQueueSessionPragmas
} from "../../sqlite/write-queue/session-pragmas.js";
import {
  createWorkerThreadSqliteWriteQueuePort,
  resolveSqliteWriteQueueWorkerUrl
} from "../../sqlite/write-queue/worker-port.js";
import type { SqliteWriteQueuePort } from "../../sqlite/write-queue/port.js";

const BENCH_CACHE_SIZE_KIB = 65_536;
const SQLITE_TEMP_STORE_DEFAULT = 0;
const SQLITE_TEMP_STORE_FILE = 1;
const SQLITE_TEMP_STORE_MEMORY = 2;
const SQLITE_SYNCHRONOUS_NORMAL = 1;

const PRAGMA_SNAPSHOT_STATEMENTS = [
  {
    sql: "CREATE TABLE IF NOT EXISTS pragma_snapshot (name TEXT PRIMARY KEY, value INTEGER NOT NULL)"
  },
  { sql: "DELETE FROM pragma_snapshot" },
  {
    sql: "INSERT INTO pragma_snapshot (name, value) SELECT 'cache_size', cache_size FROM pragma_cache_size"
  },
  {
    sql: "INSERT INTO pragma_snapshot (name, value) SELECT 'temp_store', temp_store FROM pragma_temp_store"
  },
  {
    sql: "INSERT INTO pragma_snapshot (name, value) SELECT 'synchronous', synchronous FROM pragma_synchronous"
  }
] as const;

describe("write-queue worker session pragmas", () => {
  const roots: string[] = [];
  const queues: SqliteWriteQueuePort[] = [];
  const configuredFilenames: string[] = [];

  afterEach(async () => {
    while (configuredFilenames.length > 0) {
      configureSqliteWriteQueueSessionPragmas(configuredFilenames.pop()!, null);
    }
    while (queues.length > 0) {
      await queues.pop()?.close?.();
    }
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  function createQueue(): SqliteWriteQueuePort {
    const workerUrl = resolveSqliteWriteQueueWorkerUrl();
    expect(workerUrl).not.toBeNull();
    const queue = createWorkerThreadSqliteWriteQueuePort({ workerUrl: workerUrl! });
    queues.push(queue);
    return queue;
  }

  function createProbeDb(): { readonly filename: string; readonly db: Database.Database } {
    const root = mkdtempSync(join(tmpdir(), "alaya-write-queue-session-pragma-"));
    roots.push(root);
    const filename = join(root, "probe.db");
    const db = new Database(filename);
    db.pragma("journal_mode = WAL");
    db.exec(
      "CREATE TABLE probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)"
    );
    return { filename, db };
  }

  function handshake(filename: string, pragmas: {
    readonly cacheSizeKib: number;
    readonly tempStore: "FILE" | "MEMORY";
  }): void {
    configureSqliteWriteQueueSessionPragmas(filename, pragmas);
    configuredFilenames.push(filename);
  }

  async function snapshotWorkerPragmas(
    queue: SqliteWriteQueuePort,
    filename: string,
    jobId: string
  ): Promise<void> {
    await queue.enqueue({
      jobId,
      kind: "maintenance",
      filename,
      payload: { statements: PRAGMA_SNAPSHOT_STATEMENTS }
    });
  }

  function readPragmaSnapshot(db: Database.Database): {
    readonly cache_size: number;
    readonly temp_store: number;
    readonly synchronous: number;
  } {
    const rows = db.prepare("SELECT name, value FROM pragma_snapshot").all() as Array<{
      name: string;
      value: number;
    }>;
    const snapshot = Object.fromEntries(rows.map((row) => [row.name, row.value]));
    expect(snapshot).toEqual(
      expect.objectContaining({
        cache_size: expect.any(Number),
        temp_store: expect.any(Number),
        synchronous: expect.any(Number)
      })
    );
    return snapshot as {
      cache_size: number;
      temp_store: number;
      synchronous: number;
    };
  }

  it("keeps production cache_size/temp_store defaults when no handshake is registered", async () => {
    const queue = createQueue();
    const { filename, db } = createProbeDb();

    await snapshotWorkerPragmas(queue, filename, "pragma-default");
    const snapshot = readPragmaSnapshot(db);

    expect(snapshot.cache_size).not.toBe(-BENCH_CACHE_SIZE_KIB);
    expect(snapshot.temp_store).toBe(SQLITE_TEMP_STORE_DEFAULT);
    expect(snapshot.synchronous).toBe(SQLITE_SYNCHRONOUS_NORMAL);
    db.close();
  }, 60_000);

  it("applies handed cache_size/temp_store on the worker connection without synchronous=OFF", async () => {
    const queue = createQueue();
    const { filename, db } = createProbeDb();
    handshake(filename, { cacheSizeKib: BENCH_CACHE_SIZE_KIB, tempStore: "FILE" });

    await snapshotWorkerPragmas(queue, filename, "pragma-fast");
    await queue.enqueue({
      jobId: "committed-row",
      kind: "ontology_write",
      filename,
      payload: {
        statements: [{ sql: "INSERT INTO probe (payload) VALUES (?)", params: ["ok"] }]
      }
    });

    const snapshot = readPragmaSnapshot(db);
    expect(snapshot.cache_size).toBe(-BENCH_CACHE_SIZE_KIB);
    expect(snapshot.temp_store).toBe(SQLITE_TEMP_STORE_FILE);
    expect(snapshot.synchronous).toBe(SQLITE_SYNCHRONOUS_NORMAL);
    const count = (db.prepare("SELECT COUNT(*) AS count FROM probe").get() as { count: number }).count;
    expect(count).toBe(1);
    db.close();
  }, 60_000);

  it("updates an already-open worker connection and leaves an unconfigured sibling at defaults", async () => {
    const queue = createQueue();
    const first = createProbeDb();
    const sibling = createProbeDb();

    await snapshotWorkerPragmas(queue, first.filename, "pragma-before-handshake");
    expect(readPragmaSnapshot(first.db).cache_size).not.toBe(-BENCH_CACHE_SIZE_KIB);

    handshake(first.filename, { cacheSizeKib: 131_072, tempStore: "MEMORY" });
    await snapshotWorkerPragmas(queue, first.filename, "pragma-after-handshake");
    await snapshotWorkerPragmas(queue, sibling.filename, "pragma-sibling");

    const updated = readPragmaSnapshot(first.db);
    expect(updated.cache_size).toBe(-131_072);
    expect(updated.temp_store).toBe(SQLITE_TEMP_STORE_MEMORY);
    expect(updated.synchronous).toBe(SQLITE_SYNCHRONOUS_NORMAL);

    const siblingSnapshot = readPragmaSnapshot(sibling.db);
    expect(siblingSnapshot.cache_size).not.toBe(-131_072);
    expect(siblingSnapshot.temp_store).toBe(SQLITE_TEMP_STORE_DEFAULT);
    expect(siblingSnapshot.synchronous).toBe(SQLITE_SYNCHRONOUS_NORMAL);

    first.db.close();
    sibling.db.close();
  }, 60_000);

  it("restores production cache_size/temp_store after handshake is cleared on a live worker", async () => {
    const queue = createQueue();
    const { filename, db } = createProbeDb();
    handshake(filename, { cacheSizeKib: BENCH_CACHE_SIZE_KIB, tempStore: "FILE" });

    await snapshotWorkerPragmas(queue, filename, "pragma-before-clear");
    expect(readPragmaSnapshot(db).cache_size).toBe(-BENCH_CACHE_SIZE_KIB);

    configureSqliteWriteQueueSessionPragmas(filename, null);
    await snapshotWorkerPragmas(queue, filename, "pragma-after-clear");
    const snapshot = readPragmaSnapshot(db);
    expect(snapshot.cache_size).not.toBe(-BENCH_CACHE_SIZE_KIB);
    expect(snapshot.temp_store).toBe(SQLITE_TEMP_STORE_DEFAULT);
    expect(snapshot.synchronous).toBe(SQLITE_SYNCHRONOUS_NORMAL);
    db.close();
  }, 60_000);
});
