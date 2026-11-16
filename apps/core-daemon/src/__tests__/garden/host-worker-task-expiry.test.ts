import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  type GardenTaskKindValue
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  type GardenTaskRow,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createHostWorkerTaskExpirer } from "../../garden/host-worker/host-worker-task-maintenance.js";

const NOW = "2026-05-21T00:00:00.000Z";
const OLD = "2026-05-01T00:00:00.000Z";
const OLDER_NEXT = "2026-05-02T00:00:00.000Z";
const RECENT = "2026-05-20T00:00:00.000Z";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ERROR =
  "Statement session chunk expired unclaimed past the host-worker TTL; its raw source remains available.";

type Warning = Readonly<{ message: string; meta: Record<string, unknown> }>;
type Harness = Readonly<{
  database: StorageDatabase;
  directory: string;
  repo: SqliteGardenTaskRepo;
  warnings: Warning[];
  expire: () => Promise<void>;
}>;

const harnesses: Harness[] = [];
afterEach(() => {
  for (const opened of harnesses.splice(0)) {
    opened.database.close();
    rmSync(opened.directory, { recursive: true, force: true });
  }
});

describe("host-worker unclaimed task expiry", () => {
  it("pairs each statement-session expiry with that row's completion and keeps both run inventories", async () => {
    const env = openHarness();
    enqueue(env.repo, { id: "session-a", kind: GardenTaskKind.SOURCE_STATEMENT_SESSION,
      workspace_id: "workspace-a", run_id: "run-a", created_at: OLD });
    enqueue(env.repo, { id: "session-b", kind: GardenTaskKind.SOURCE_STATEMENT_SESSION,
      workspace_id: "workspace-b", run_id: "run-b", created_at: OLDER_NEXT });

    await env.expire();

    expect(env.repo.findById("session-a")).toMatchObject({
      status: "failed", outcome: "failed", last_error_text: SESSION_ERROR, claimed_by: null
    });
    expect(env.repo.findById("session-b")).toMatchObject({
      status: "failed", outcome: "failed", last_error_text: SESSION_ERROR, claimed_by: null
    });
    expect(gardenEvents(env.database)).toEqual([
      expiredEvent("session-a", "workspace-a", "run-a", OLD, GardenTaskKind.SOURCE_STATEMENT_SESSION),
      failedCompletion("session-a", "workspace-a", "run-a", GardenTaskKind.SOURCE_STATEMENT_SESSION),
      expiredEvent("session-b", "workspace-b", "run-b", OLDER_NEXT, GardenTaskKind.SOURCE_STATEMENT_SESSION),
      failedCompletion("session-b", "workspace-b", "run-b", GardenTaskKind.SOURCE_STATEMENT_SESSION)
    ]);
    expect(env.warnings).toEqual([warning(GardenTaskKind.SOURCE_STATEMENT_SESSION, 2)]);
  });

  it("reads the next statement-session run_id after the previous completion write settles", async () => {
    const order: string[] = [];
    const env = openHarness((repo) => overlay(repo, {
      peekExpiredUnclaimedTasks: (kind, expiredBeforeIso, limit) => {
        const rows = repo.peekExpiredUnclaimedTasks(kind, expiredBeforeIso, limit);
        if (kind !== GardenTaskKind.SOURCE_STATEMENT_SESSION) {
          return rows;
        }
        return rows.map((row) => {
          const payload = row.payload as { readonly run_id?: unknown };
          const runId = payload.run_id;
          return {
            ...row,
            payload: {
              ...payload,
              get run_id() {
                order.push(`run_id:${row.id}`);
                return runId;
              }
            }
          };
        });
      },
      failPendingWithCompletionEvent: async (taskId, ...rest) => {
        const applied = await repo.failPendingWithCompletionEvent(taskId, ...rest);
        order.push(`completed:${taskId}`);
        return applied;
      }
    }));
    enqueue(env.repo, { id: "session-a", kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, run_id: "run-a" });
    enqueue(env.repo, { id: "session-b", kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, run_id: "run-b",
      created_at: OLDER_NEXT });

    await env.expire();

    const afterFirst = order.indexOf("completed:session-a");
    expect(afterFirst).toBeGreaterThanOrEqual(0);
    expect(order.slice(afterFirst + 1)).toContain("run_id:session-b");
    expect(env.repo.findById("session-a")).toMatchObject({ status: "failed", last_error_text: SESSION_ERROR });
    expect(env.repo.findById("session-b")).toMatchObject({ status: "failed", last_error_text: SESSION_ERROR });
  });

  it("deletes eligible EDGE_CLASSIFY tasks with one expiry event per row and leaves protected work", async () => {
    const env = openHarness();
    enqueue(env.repo, { id: "edge-a", kind: GardenTaskKind.EDGE_CLASSIFY,
      workspace_id: "workspace-a", run_id: "run-a", created_at: OLD });
    enqueue(env.repo, { id: "edge-b", kind: GardenTaskKind.EDGE_CLASSIFY,
      workspace_id: "workspace-b", run_id: "run-b", created_at: OLDER_NEXT });
    enqueue(env.repo, { id: "edge-recent", kind: GardenTaskKind.EDGE_CLASSIFY, created_at: RECENT });
    enqueue(env.repo, { id: "edge-claimed", kind: GardenTaskKind.EDGE_CLASSIFY, created_at: OLD });
    enqueue(env.repo, { id: "post-turn", kind: GardenTaskKind.POST_TURN_EXTRACT, created_at: OLD });
    await env.repo.claimAtomic("edge-claimed", "worker", NOW);

    await env.expire();

    expect(env.repo.findById("edge-a")).toBeNull();
    expect(env.repo.findById("edge-b")).toBeNull();
    expect(env.repo.findById("edge-recent")).toMatchObject({ status: "pending" });
    expect(env.repo.findById("edge-claimed")).toMatchObject({ status: "claimed", claimed_by: "worker" });
    expect(env.repo.findById("post-turn")).toMatchObject({ status: "pending" });
    expect(gardenEvents(env.database)).toEqual([
      expiredEvent("edge-a", "workspace-a", "run-a", OLD, GardenTaskKind.EDGE_CLASSIFY),
      expiredEvent("edge-b", "workspace-b", "run-b", OLDER_NEXT, GardenTaskKind.EDGE_CLASSIFY)
    ]);
    expect(env.warnings).toEqual([warning(GardenTaskKind.EDGE_CLASSIFY, 2)]);
  });

  it("counts only the statement-session rows that still lose the pending CAS", async () => {
    const env = openHarness((repo, database) => overlay(repo, {
      peekExpiredUnclaimedTasks: (kind, expiredBeforeIso, limit) => {
        const rows = repo.peekExpiredUnclaimedTasks(kind, expiredBeforeIso, limit);
        if (kind === GardenTaskKind.SOURCE_STATEMENT_SESSION && rows[1] !== undefined) {
          database.connection.prepare(
            `UPDATE garden_tasks SET status = 'claimed', claimed_by = 'racer', claimed_at = ? WHERE id = ? AND status = 'pending'`
          ).run(NOW, rows[1].id);
        }
        return rows;
      }
    }));
    enqueue(env.repo, { id: "session-a", kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, run_id: "run-a" });
    enqueue(env.repo, { id: "session-b", kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, run_id: "run-b",
      created_at: OLDER_NEXT });

    await env.expire();

    expect(env.repo.findById("session-a")).toMatchObject({ status: "failed", last_error_text: SESSION_ERROR });
    expect(env.repo.findById("session-b")).toMatchObject({ status: "claimed", claimed_by: "racer" });
    expect(gardenEvents(env.database)).toEqual([
      expiredEvent("session-a", "workspace-1", "run-a", OLD, GardenTaskKind.SOURCE_STATEMENT_SESSION),
      failedCompletion("session-a", "workspace-1", "run-a", GardenTaskKind.SOURCE_STATEMENT_SESSION)
    ]);
    expect(env.warnings).toEqual([warning(GardenTaskKind.SOURCE_STATEMENT_SESSION, 1)]);
  });

  it("does not warn when every selected statement session loses the race", async () => {
    const env = openHarness((repo, database) => overlay(repo, {
      peekExpiredUnclaimedTasks: (kind, expiredBeforeIso, limit) => {
        const rows = repo.peekExpiredUnclaimedTasks(kind, expiredBeforeIso, limit);
        if (kind === GardenTaskKind.SOURCE_STATEMENT_SESSION) {
          for (const row of rows) {
            database.connection.prepare(
              `UPDATE garden_tasks SET status = 'claimed', claimed_by = 'racer', claimed_at = ? WHERE id = ? AND status = 'pending'`
            ).run(NOW, row.id);
          }
        }
        return rows;
      }
    }));
    enqueue(env.repo, { id: "session-a", kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, run_id: "run-a" });
    enqueue(env.repo, { id: "session-b", kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, run_id: "run-b",
      created_at: OLDER_NEXT });

    await env.expire();

    expect(env.repo.findById("session-a")).toMatchObject({ status: "claimed", claimed_by: "racer" });
    expect(env.repo.findById("session-b")).toMatchObject({ status: "claimed", claimed_by: "racer" });
    expect(gardenEvents(env.database)).toEqual([]);
    expect(env.warnings).toEqual([]);
  });

  it("does not write when a later expiry payload fails to parse", async () => {
    const env = openHarness((repo) => overlay(repo, {
      peekExpiredUnclaimedTasks: (kind, expiredBeforeIso, limit) => {
        const rows = repo.peekExpiredUnclaimedTasks(kind, expiredBeforeIso, limit);
        if (kind !== GardenTaskKind.EDGE_CLASSIFY || rows[1] === undefined) {
          return rows;
        }
        return [rows[0]!, { ...rows[1]!, role: "not-a-role" as GardenTaskRow["role"] }];
      }
    }));
    enqueue(env.repo, { id: "edge-a", kind: GardenTaskKind.EDGE_CLASSIFY, run_id: "run-a" });
    enqueue(env.repo, { id: "edge-b", kind: GardenTaskKind.EDGE_CLASSIFY, run_id: "run-b", created_at: OLDER_NEXT });

    await expect(env.expire()).rejects.toThrow();
    expect(env.repo.findById("edge-a")).toMatchObject({ status: "pending" });
    expect(env.repo.findById("edge-b")).toMatchObject({ status: "pending" });
    expect(gardenEvents(env.database)).toEqual([]);
    expect(env.warnings).toEqual([]);
  });

  it("keeps an earlier statement-session failure when a later completion write throws", async () => {
    const env = openHarness((repo) => overlay(repo, {
      failPendingWithCompletionEvent: async (taskId, ...rest) => {
        if (taskId === "session-b") {
          throw new Error("completion write failed");
        }
        return repo.failPendingWithCompletionEvent(taskId, ...rest);
      }
    }));
    enqueue(env.repo, { id: "session-a", kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, run_id: "run-a" });
    enqueue(env.repo, { id: "session-b", kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, run_id: "run-b",
      created_at: OLDER_NEXT });

    await expect(env.expire()).rejects.toThrow(/completion write failed/);
    expect(env.repo.findById("session-a")).toMatchObject({ status: "failed", last_error_text: SESSION_ERROR });
    expect(env.repo.findById("session-b")).toMatchObject({ status: "pending" });
    expect(gardenEvents(env.database)).toEqual([
      expiredEvent("session-a", "workspace-1", "run-a", OLD, GardenTaskKind.SOURCE_STATEMENT_SESSION),
      failedCompletion("session-a", "workspace-1", "run-a", GardenTaskKind.SOURCE_STATEMENT_SESSION)
    ]);
    expect(env.warnings).toEqual([]);
  });
});

function openHarness(
  intercept?: (repo: SqliteGardenTaskRepo, database: StorageDatabase) => SqliteGardenTaskRepo
): Harness {
  const directory = mkdtempSync(join(tmpdir(), "alaya-host-task-expiry-"));
  const database = initDatabase({ filename: join(directory, "memory.sqlite") });
  const eventPublisher = new EventPublisher({
    eventLogRepo: new SqliteEventLogRepo(database),
    runHotStateService: { apply: () => undefined },
    runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
  });
  const repo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
  const warnings: Warning[] = [];
  const opened: Harness = {
    database,
    directory,
    repo,
    warnings,
    expire: createHostWorkerTaskExpirer({
      now: () => NOW,
      gardenTaskRepo: intercept === undefined ? repo : intercept(repo, database),
      warn: (message, meta) => {
        warnings.push({ message, meta });
      }
    })
  };
  harnesses.push(opened);
  return opened;
}

function overlay(
  repo: SqliteGardenTaskRepo,
  methods: Partial<Pick<SqliteGardenTaskRepo, "peekExpiredUnclaimedTasks" | "failPendingWithCompletionEvent">>
): SqliteGardenTaskRepo {
  return new Proxy(repo, {
    get(target, property, receiver) {
      if (property === "peekExpiredUnclaimedTasks" && methods.peekExpiredUnclaimedTasks !== undefined) {
        return methods.peekExpiredUnclaimedTasks;
      }
      if (property === "failPendingWithCompletionEvent" && methods.failPendingWithCompletionEvent !== undefined) {
        return methods.failPendingWithCompletionEvent;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    }
  });
}

function enqueue(repo: SqliteGardenTaskRepo, input: Readonly<{
  id: string;
  kind: GardenTaskKindValue;
  workspace_id?: string;
  run_id?: string;
  created_at?: string;
}>): void {
  repo.enqueue({
    id: input.id,
    workspace_id: input.workspace_id ?? "workspace-1",
    role: GardenRole.LIBRARIAN,
    kind: input.kind,
    payload: { task_kind: input.kind, run_id: input.run_id },
    created_at: input.created_at ?? OLD
  });
}

function gardenEvents(database: StorageDatabase) {
  return (database.connection.prepare(`
    SELECT event_type, entity_id, workspace_id, run_id, payload_json
    FROM event_log WHERE entity_type = 'garden_task'
    ORDER BY created_at ASC, rowid ASC
  `).all() as readonly Readonly<{
    event_type: string;
    entity_id: string;
    workspace_id: string;
    run_id: string | null;
    payload_json: string;
  }>[]).map((row) => ({
    event_type: row.event_type,
    entity_id: row.entity_id,
    workspace_id: row.workspace_id,
    run_id: row.run_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>
  }));
}

function warning(taskKind: GardenTaskKindValue, removed: number): Warning {
  return {
    message: "expired never-claimed host-worker garden tasks past TTL",
    meta: { task_kind: taskKind, removed, ttl_ms: TTL_MS }
  };
}

function expiredEvent(
  taskId: string,
  workspaceId: string,
  runId: string,
  enqueuedAt: string,
  taskKind: GardenTaskKindValue
) {
  return {
    event_type: GardenEventType.SOUL_GARDEN_TASK_EXPIRED,
    entity_id: taskId,
    workspace_id: workspaceId,
    run_id: runId,
    payload: expect.objectContaining({
      task_id: taskId,
      task_kind: taskKind,
      workspace_id: workspaceId,
      run_id: runId,
      enqueued_at: enqueuedAt,
      ttl_ms: TTL_MS,
      occurred_at: NOW
    })
  };
}

function failedCompletion(
  taskId: string,
  workspaceId: string,
  runId: string,
  taskKind: GardenTaskKindValue
) {
  return {
    event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
    entity_id: taskId,
    workspace_id: workspaceId,
    run_id: runId,
    payload: expect.objectContaining({
      task_id: taskId,
      task_kind: taskKind,
      success: false,
      outcome: "failed",
      objects_affected: [],
      candidate_signals_count: 0,
      occurred_at: NOW
    })
  };
}
