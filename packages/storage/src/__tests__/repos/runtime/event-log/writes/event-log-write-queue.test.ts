import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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

  it("queued EventLog append leaves main-thread reads responsive vs sync append", async () => {
    const workerUrl = resolveSqliteWriteQueueWorkerUrl();
    expect(workerUrl).not.toBeNull();
    const queue = createWorkerThreadSqliteWriteQueuePort({ workerUrl: workerUrl! });
    queues.push(queue);

    const root = mkdtempSync(join(tmpdir(), "alaya-event-log-tail-"));
    roots.push(root);
    const { database, eventLogRepo } = await createEventLogRepos({
      filename: join(root, "alaya.db")
    });
    const select = database.connection.prepare("SELECT COUNT(*) AS count FROM event_log");
    const appendSql = database.connection.prepare(EVENT_LOG_APPEND_WITH_REVISION_SQL);

    const syncBlockMs = 100;
    const syncFirstReadDelayMs = await measureFirstReadDelayAfterKickoff({
      kickoff: () => {
        const deadline = performance.now() + syncBlockMs;
        database.connection.transaction(() => {
          let index = 0;
          while (performance.now() < deadline) {
            appendSql.run(
              `sync-${index}`,
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
                content: `sync-${index}`,
                message_id: `sync-${index}`
              }),
              new Date().toISOString()
            );
            index += 1;
          }
        })();
      },
      runRead: () => {
        select.get();
      }
    });

    configureSqliteWriteQueuePort(queue);
    // One production-shaped EventLog payload job (same SQL as appendViaWriteQueue),
    // not thousands of main-thread Promise setups that would stall before setImmediate.
    const heavyStatements = Array.from({ length: 4_000 }, (_, index) => ({
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
          message_id: `queued-heavy-${index}`
        }),
        new Date().toISOString()
      ] as const
    }));
    let queuedWrite: Promise<void> = Promise.resolve();
    try {
      const workerFirstReadDelayMs = await measureFirstReadDelayAfterKickoff({
        kickoff: () => {
          queuedWrite = queue.enqueue({
            jobId: "event-log-heavy-batch",
            kind: "event_log_transaction",
            filename: database.filename,
            payload: { statements: heavyStatements }
          });
        },
        runRead: () => {
          select.get();
        }
      });

      // Prove the repo path also uses the queue (async) after the heavy job.
      const repoAppend = eventLogRepo.append({
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

      expect(syncFirstReadDelayMs).toBeGreaterThan(syncBlockMs * 0.8);
      expect(workerFirstReadDelayMs).toBeLessThan(syncFirstReadDelayMs / 2);
      expect(workerFirstReadDelayMs).toBeLessThan(50);
      await repoAppend;
    } finally {
      await queuedWrite.catch(() => undefined);
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
