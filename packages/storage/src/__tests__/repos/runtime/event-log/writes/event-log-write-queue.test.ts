import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RunMode, WorkspaceRunEventType } from "@do-soul/alaya-protocol";
import { EVENT_LOG_APPEND_WITH_REVISION_SQL } from "../../../../../repos/runtime/event-log/statements/append-sql.js";
import {
  configureSqliteWriteQueuePort,
  createWorkerThreadSqliteWriteQueuePort,
  resolveSqliteWriteQueueWorkerUrl
} from "../../../../../sqlite/index.js";
import { createEventLogRepos, trackedDatabases } from "../../event-log-repo-fixture.js";

describe("EventLog append via worker write queue", () => {
  const roots: string[] = [];
  const queues: Array<ReturnType<typeof createWorkerThreadSqliteWriteQueuePort>> = [];

  afterEach(async () => {
    configureSqliteWriteQueuePort(null);
    while (queues.length > 0) {
      await queues.pop()?.close?.();
    }
    for (const database of trackedDatabases) {
      database.close();
    }
    trackedDatabases.clear();
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  async function createQueuedRepos() {
    const workerUrl = resolveSqliteWriteQueueWorkerUrl();
    expect(workerUrl).not.toBeNull();
    const queue = createWorkerThreadSqliteWriteQueuePort({ workerUrl: workerUrl! });
    queues.push(queue);
    configureSqliteWriteQueuePort(queue);

    const root = mkdtempSync(join(tmpdir(), "alaya-event-log-queue-"));
    roots.push(root);
    return await createEventLogRepos({ filename: join(root, "alaya.db") });
  }

  it("assigns monotonic revisions under concurrent standalone appends (CAS)", async () => {
    const { eventLogRepo } = await createQueuedRepos();

    const appends = Array.from({ length: 8 }, (_, index) =>
      eventLogRepo.append({
        event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
        entity_type: "run",
        entity_id: "run_order",
        workspace_id: "ws_events",
        run_id: "run_order",
        caused_by: "user_action",
        payload_json: {
          run_id: "run_order",
          role: "user",
          content: `queued-${index}`,
          message_id: `msg-${index}`
        }
      })
    );

    const entries = await Promise.all(appends);
    const revisions = entries.map((entry) => entry.revision).sort((left, right) => left - right);
    expect(revisions).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const stored = await eventLogRepo.queryByEntityAll("run", "run_order");
    expect(stored.map((entry) => entry.revision)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  }, 60_000);

  it("keeps in-transaction append synchronous for EventLog-first CAS", async () => {
    const { eventLogRepo } = await createQueuedRepos();

    const result = eventLogRepo.transactional(() => {
      const first = eventLogRepo.append({
        event_type: WorkspaceRunEventType.RUN_CREATED,
        entity_type: "run",
        entity_id: "run_txn",
        workspace_id: "ws_events",
        run_id: "run_order",
        caused_by: "user_action",
        payload_json: {
          run_id: "run_txn",
          workspace_id: "ws_events",
          run_mode: RunMode.CHAT,
          title: "txn"
        }
      });
      expect(first).not.toBeInstanceOf(Promise);
      const second = eventLogRepo.append({
        event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
        entity_type: "run",
        entity_id: "run_txn",
        workspace_id: "ws_events",
        run_id: "run_order",
        caused_by: "user_action",
        payload_json: {
          run_id: "run_txn",
          role: "user",
          content: "inside-txn",
          message_id: "msg-txn"
        }
      });
      expect(second).not.toBeInstanceOf(Promise);
      if (first instanceof Promise || second instanceof Promise) {
        throw new Error("expected synchronous in-transaction appends");
      }
      return { first, second };
    });

    expect(result.first.revision).toBe(0);
    expect(result.second.revision).toBe(1);
  }, 60_000);

  it("standalone queued append returns a Promise and persists the row", async () => {
    const { eventLogRepo } = await createQueuedRepos();
    const pending = eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run_queued",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_queued",
        workspace_id: "ws_events",
        run_mode: RunMode.CHAT,
        title: "queued"
      }
    });
    expect(pending).toBeInstanceOf(Promise);
    const entry = await pending;
    expect(entry.revision).toBe(0);
    expect(entry.entity_id).toBe("run_queued");
  }, 60_000);

  it("concurrent worker append and main insertEventLogEntry do not spuriously fail", async () => {
    const { database, eventLogRepo } = await createQueuedRepos();
    const { getEventLogWriter, insertEventLogEntry } = await import(
      "../../../../../repos/runtime/writes/event-log-writer.js"
    );
    const writer = getEventLogWriter(database.connection);

    const workerAppends = Array.from({ length: 12 }, (_, index) =>
      eventLogRepo.append({
        event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
        entity_type: "run",
        entity_id: "run_cas_mix",
        workspace_id: "ws_events",
        run_id: "run_order",
        caused_by: "user_action",
        payload_json: {
          run_id: "run_cas_mix",
          role: "user",
          content: `worker-${index}`,
          message_id: `worker-${index}`
        }
      })
    );

    const mainInserts = Array.from({ length: 12 }, (_, index) =>
      Promise.resolve().then(() =>
        database.connection
          .transaction(() =>
            insertEventLogEntry(writer, {
              event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
              entity_type: "run",
              entity_id: "run_cas_mix",
              workspace_id: "ws_events",
              run_id: "run_order",
              caused_by: "user_action",
              payload_json: {
                run_id: "run_cas_mix",
                role: "user",
                content: `main-${index}`,
                message_id: `main-${index}`
              }
            })
          )
          .immediate()
      )
    );

    const settled = await Promise.allSettled([...workerAppends, ...mainInserts]);
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(rejected).toEqual([]);

    const stored = await eventLogRepo.queryByEntityAll("run", "run_cas_mix");
    expect(stored).toHaveLength(24);
    expect(stored.map((entry) => entry.revision).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index)
    );
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "reads during an active worker EventLog transaction and preserves append order",
    async () => {
      const workerUrl = resolveSqliteWriteQueueWorkerUrl();
      expect(workerUrl).not.toBeNull();
      const queue = createWorkerThreadSqliteWriteQueuePort({ workerUrl: workerUrl! });
      queues.push(queue);

      const root = mkdtempSync(join(tmpdir(), "alaya-event-log-tail-"));
      roots.push(root);
      const { database, eventLogRepo } = await createEventLogRepos({
        filename: join(root, "alaya.db")
      });
      const connection = database.connection;
      connection.pragma("busy_timeout = 0");
      const select = connection.prepare("SELECT COUNT(*) AS count FROM event_log");
      const appendSql = connection.prepare(EVENT_LOG_APPEND_WITH_REVISION_SQL);
      const heavyStatements = createAppendBatch();
      let gate: Database.Database | undefined;
      let queuedWrite: Promise<void> = Promise.resolve();
      let repoAppend: ReturnType<typeof eventLogRepo.append> | undefined;
      try {
        expect(select.get()).toEqual({ count: 0 });
        let syncReadRan = false;
        const syncRead = nextTurn().then(() => { syncReadRan = true; });
        connection.transaction(() => {
          heavyStatements.forEach((statement, index) => {
            appendSql.run(`sync-${index}`, ...statement.params.slice(1));
          });
          expect(syncReadRan).toBe(false);
        })();
        await syncRead;
        expect(select.get()).toEqual({ count: 4_000 });

        const gateFilename = join(root, "gate.db");
        gate = new Database(gateFilename);
        gate.pragma("journal_mode = WAL");
        gate.exec("CREATE TABLE gate (value INTEGER NOT NULL); BEGIN IMMEDIATE");
        configureSqliteWriteQueuePort(queue);
        let workerSettled = false;
        queuedWrite = queue.enqueue({
          jobId: "event-log-heavy-batch",
          kind: "event_log_transaction",
          filename: database.filename,
          payload: {
            statements: [
              { sql: "ATTACH DATABASE ? AS write_gate", params: [gateFilename] },
              { sql: "INSERT INTO write_gate.gate (value) VALUES (1)" },
              ...heavyStatements
            ]
          }
        });
        void queuedWrite.then(
          () => { workerSettled = true; },
          () => { workerSettled = true; }
        );
        // BEGIN IMMEDIATE in the real worker precedes its blocked gate insert.
        await expect.poll(() => isWriteLocked(connection), { timeout: 5_000, interval: 10 }).toBe(true);
        await nextTurn();
        expect(select.get()).toEqual({ count: 4_000 });
        expect(isWriteLocked(connection)).toBe(true);
        expect(workerSettled).toBe(false);

        // Enqueue through the repository while the heavy transaction is active.
        repoAppend = eventLogRepo.append({
          event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
          entity_type: "run",
          entity_id: "run_order",
          workspace_id: "ws_events",
          run_id: "run_order",
          caused_by: "user_action",
          payload_json: {
            run_id: "run_order",
            role: "user",
            content: "post-heavy",
            message_id: "post-heavy"
          }
        });
        expect(repoAppend).toBeInstanceOf(Promise);
        void Promise.resolve(repoAppend).catch(() => undefined);
        gate.exec("ROLLBACK");
        await queuedWrite;
        const entry = await repoAppend;
        expect(entry.revision).toBe(8_000);
        expect(entry.payload_json).toEqual({
          run_id: "run_order", role: "user", content: "post-heavy", message_id: "post-heavy"
        });
        const stored = [...await eventLogRepo.queryByEntityAll("run", "run_order")]
          .sort((left, right) => left.revision - right.revision);
        expect(stored.map((event) => event.revision)).toEqual(
          Array.from({ length: 8_001 }, (_, index) => index)
        );
        expect(stored.slice(0, 4_000).map((event) => event.event_id)).toEqual(
          Array.from({ length: 4_000 }, (_, index) => `sync-${index}`)
        );
        expect(stored.slice(4_000, 8_000).map((event) => event.event_id)).toEqual(
          Array.from({ length: 4_000 }, (_, index) => `queued-heavy-${index}`)
        );
        expect(stored[8_000]?.event_id).toBe(entry.event_id);
        expect(select.get()).toEqual({ count: 8_001 });
        expect(gate.prepare("SELECT COUNT(*) AS count FROM gate").get()).toEqual({ count: 1 });
      } finally {
        if (gate?.inTransaction) gate.exec("ROLLBACK");
        await queuedWrite.catch(() => undefined);
        await Promise.resolve(repoAppend).catch(() => undefined);
        gate?.close();
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

function createAppendBatch() {
  return Array.from({ length: 4_000 }, (_, index) => ({
    sql: EVENT_LOG_APPEND_WITH_REVISION_SQL,
    params: [
      `queued-heavy-${index}`,
      WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      "run",
      "run_order",
      "ws_events",
      "run_order",
      "user_action",
      "run",
      "run_order",
      JSON.stringify({
        run_id: "run_order",
        role: "user",
        content: `queued-heavy-${index}`,
        message_id: `msg-${index}`
      }),
      new Date().toISOString()
    ] as const
  }));
}
