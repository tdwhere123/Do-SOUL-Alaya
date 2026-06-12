import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceRunEventType,
  RunMode,
  RunState,
  TrustStateEventType,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteEventLogRepo", () => {
  it("append generates a unique event_id and created_at", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    const event = await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        workspace_id: "ws_events",
        name: "events",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    });

    expect(event.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(event.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("queryByRun returns only matching run events", async () => {
    const { eventLogRepo } = await createEventLogRepos();
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run_target",
      workspace_id: "ws_events",
      run_id: "run_target",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_target",
        workspace_id: "ws_events",
        run_mode: RunMode.CHAT,
        title: "target"
      }
    });
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run_other",
      workspace_id: "ws_events",
      run_id: "run_other",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_other",
        workspace_id: "ws_events",
        run_mode: RunMode.BUILD,
        title: "other"
      }
    });

    const events = await eventLogRepo.queryByRun("run_target");

    expect(events).toHaveLength(1);
    expect(events[0]?.run_id).toBe("run_target");
  });

  it("queryByEntity returns only matching entity events", async () => {
    const { eventLogRepo } = await createEventLogRepos();
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_match",
      workspace_id: "ws_match",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        workspace_id: "ws_match",
        name: "match",
        workspace_kind: WorkspaceKind.DOCS_ONLY
      }
    });
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_other",
      workspace_id: "ws_other",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        workspace_id: "ws_other",
        name: "other",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    });

    const events = await eventLogRepo.queryByEntity("workspace", "ws_match");

    expect(events).toHaveLength(1);
    expect(events[0]?.entity_id).toBe("ws_match");
  });

  it("queryByType returns only matching event types", async () => {
    const { eventLogRepo } = await createEventLogRepos();
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_type",
      workspace_id: "ws_type",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        workspace_id: "ws_type",
        name: "type",
        workspace_kind: WorkspaceKind.MIXED
      }
    });
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run_type",
      workspace_id: "ws_type",
      run_id: "run_type",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_type",
        workspace_id: "ws_type",
        run_mode: RunMode.REVIEW,
        title: "type"
      }
    });

    const events = await eventLogRepo.queryByType(WorkspaceRunEventType.RUN_CREATED);

    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe(WorkspaceRunEventType.RUN_CREATED);
  });

  it("returns multiple matching events in append order", async () => {
    const { eventLogRepo } = await createEventLogRepos();
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "hello",
        message_id: "msg_1"
      }
    });
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "engine",
      payload_json: {
        run_id: "run_order",
        message_id: "msg_2",
        content: "world",
        finish_reason: "stop"
      }
    });

    const events = await eventLogRepo.queryByRun("run_order");

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.event_type)).toEqual([
      WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED
    ]);
  });

  it("queryByRunAfterEventId returns only events after the target event ID", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    const first = await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "first",
        message_id: "msg_1"
      }
    });
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "second",
        message_id: "msg_2"
      }
    });
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "engine",
      payload_json: {
        run_id: "run_order",
        message_id: "msg_3",
        content: "third",
        finish_reason: "stop"
      }
    });

    const events = await eventLogRepo.queryByRunAfterEventId("run_order", first.event_id);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.revision)).toEqual([1, 2]);
  });

  it("queryByRunAfterEventId returns all run events when the target ID is missing", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "hello",
        message_id: "msg_1"
      }
    });
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "engine",
      payload_json: {
        run_id: "run_order",
        message_id: "msg_2",
        content: "world",
        finish_reason: "stop"
      }
    });

    const events = await eventLogRepo.queryByRunAfterEventId("run_order", "evt_missing");

    expect(events).toHaveLength(2);
  });

  it("queryByRunCursorState reports cursor presence, prefix size, and latest event id", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    const first = await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "first",
        message_id: "msg_1"
      }
    });
    const second = await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "second",
        message_id: "msg_2"
      }
    });
    const third = await eventLogRepo.append({
      event_type: WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "engine",
      payload_json: {
        run_id: "run_order",
        message_id: "msg_3",
        content: "third",
        finish_reason: "stop"
      }
    });

    const cursorState = await eventLogRepo.queryByRunCursorState("run_order", second.event_id);

    expect(cursorState).toEqual({
      cursorExists: true,
      eventsUpToCursor: 2,
      latestEventId: third.event_id
    });
    expect(cursorState.latestEventId).not.toBe(first.event_id);
  });

  it("queryByRunCursorState reports deleted cursors without losing the latest surviving event id", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    const first = await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "first",
        message_id: "msg_1"
      }
    });
    const second = await eventLogRepo.append({
      event_type: WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "engine",
      payload_json: {
        run_id: "run_order",
        message_id: "msg_2",
        content: "second",
        finish_reason: "stop"
      }
    });

    await eventLogRepo.deleteById(second.event_id);

    await expect(eventLogRepo.queryByRunCursorState("run_order", second.event_id)).resolves.toEqual({
      cursorExists: false,
      eventsUpToCursor: 0,
      latestEventId: first.event_id
    });
  });

  it("queryByRunCursorState keeps empty runs stable when the cached cursor is null", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    await expect(eventLogRepo.queryByRunCursorState("run-empty", null)).resolves.toEqual({
      cursorExists: false,
      eventsUpToCursor: 0,
      latestEventId: null
    });
  });

  it("uses the workspace index to narrow workspace-scoped query and replay shapes before sorting", async () => {
    const { database } = await createEventLogRepos();

    const workspaceQueryPlan = database.connection
      .prepare(
        `
          EXPLAIN QUERY PLAN
          SELECT event_id
          FROM event_log
          WHERE workspace_id = ?
          ORDER BY created_at ASC, rowid ASC
        `
      )
      .all("ws_events") as Array<{ readonly detail: string }>;
    const workspaceReplayPlan = database.connection
      .prepare(
        `
          EXPLAIN QUERY PLAN
          SELECT event_id
          FROM event_log
          WHERE workspace_id = ?
            AND rowid > COALESCE((
              SELECT rowid
              FROM event_log
              WHERE workspace_id = ? AND event_id = ?
              LIMIT 1
            ), 0)
          ORDER BY created_at ASC, rowid ASC
        `
      )
      .all("ws_events", "ws_events", "evt_missing") as Array<{ readonly detail: string }>;

    expect(
      workspaceQueryPlan.some((row) =>
        row.detail.includes("SEARCH event_log USING INDEX idx_event_log_workspace_id")
      )
    ).toBe(true);
    expect(workspaceQueryPlan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(true);
    expect(
      workspaceReplayPlan.some((row) =>
        row.detail.includes("SEARCH event_log USING INDEX idx_event_log_workspace_id")
      )
    ).toBe(true);
    expect(workspaceReplayPlan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(true);
  });

  it("queryByWorkspaceAndType pushes workspace, type, and since filtering into SQL for usage proofs", async () => {
    const { database, eventLogRepo } = await createEventLogRepos();
    await eventLogRepo.append({
      event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
      entity_type: "trust_usage_proof",
      entity_id: "delivery-old",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "test",
      payload_json: {
        delivery_id: "delivery-old",
        usage_state: "used",
        used_object_ids: ["memory-1"],
        reason: null,
        reported_at: "2026-05-04T09:00:00.000Z"
      }
    });
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "test",
      payload_json: {
        workspace_id: "ws_events",
        name: "events",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    });
    await eventLogRepo.append({
      event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
      entity_type: "trust_usage_proof",
      entity_id: "delivery-new",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "test",
      payload_json: {
        delivery_id: "delivery-new",
        usage_state: "used",
        used_object_ids: ["memory-2"],
        reason: null,
        reported_at: "2026-05-04T11:00:00.000Z"
      }
    });
    await eventLogRepo.append({
      event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
      entity_type: "trust_usage_proof",
      entity_id: "delivery-after-window",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "test",
      payload_json: {
        delivery_id: "delivery-after-window",
        usage_state: "used",
        used_object_ids: ["memory-3"],
        reason: null,
        reported_at: "2026-05-04T12:30:00.000Z"
      }
    });

    const events = await eventLogRepo.queryByWorkspaceAndType(
      "ws_events",
      TrustStateEventType.MEMORY_USAGE_REPORTED,
      "2026-05-04T10:00:00.000Z",
      "2026-05-04T12:00:00.000Z"
    );

    expect(events.map((event) => event.entity_id)).toEqual(["delivery-new"]);

    const queryPlan = database.connection
      .prepare(
        `
          EXPLAIN QUERY PLAN
          SELECT event_id
          FROM event_log
          WHERE workspace_id = ?
            AND event_type = ?
            AND created_at > ?
          ORDER BY created_at ASC, rowid ASC
        `
      )
      .all("ws_events", TrustStateEventType.MEMORY_USAGE_REPORTED, "2026-05-04T10:00:00.000Z") as Array<{
      readonly detail: string;
    }>;
    expect(
      queryPlan.some((row) =>
        row.detail.includes("SEARCH event_log USING INDEX idx_event_log_workspace_type_created")
      )
    ).toBe(true);
  });


  it("queryByWorkspace returns only matching workspace events", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        workspace_id: "ws_events",
        name: "events",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    });
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_other",
      workspace_id: "ws_other",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        workspace_id: "ws_other",
        name: "other",
        workspace_kind: WorkspaceKind.DOCS_ONLY
      }
    });

    const events = await eventLogRepo.queryByWorkspace("ws_events");

    expect(events).toHaveLength(1);
    expect(events[0]?.workspace_id).toBe("ws_events");
  });

  it("queryByWorkspaceAfterEventId replays events after the target event", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    const first = await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        workspace_id: "ws_events",
        name: "events",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    });

    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_DELETED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        workspace_id: "ws_events"
      }
    });

    const replay = await eventLogRepo.queryByWorkspaceAfterEventId("ws_events", first.event_id);

    expect(replay).toHaveLength(1);
    expect(replay[0]?.event_type).toBe(WorkspaceRunEventType.WORKSPACE_DELETED);
  });

  it("getLatestWorkspaceEventId returns the latest workspace event", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        workspace_id: "ws_events",
        name: "events",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    });

    const deleted = await eventLogRepo.append({
      event_type: WorkspaceRunEventType.WORKSPACE_DELETED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        workspace_id: "ws_events"
      }
    });

    await expect(eventLogRepo.getLatestWorkspaceEventId("ws_events")).resolves.toBe(deleted.event_id);
  });

  describe("transactional + append (closes #BL-022)", () => {
    it("append rolls back the row when transactional() callback throws", async () => {
      const { eventLogRepo } = await createEventLogRepos();
      expect(() =>
        eventLogRepo.transactional(() => {
          eventLogRepo.append({
            event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
            entity_type: "workspace",
            entity_id: "ws_rollback_atomic",
            workspace_id: "ws_events",
            run_id: null,
            caused_by: "user_action",
            payload_json: {
              workspace_id: "ws_rollback_atomic",
              name: "rollback",
              workspace_kind: WorkspaceKind.LOCAL_REPO
            }
          });
          throw new Error("synthetic-rollback");
        })
      ).toThrow("synthetic-rollback");

      await expect(
        eventLogRepo.queryByEntity("workspace", "ws_rollback_atomic")
      ).resolves.toEqual([]);
    });

    it("append inside transactional() computes revision atomically with the INSERT", async () => {
      const { eventLogRepo } = await createEventLogRepos();
      // Three sequential appends inside one transaction — revisions must be 0,1,2.
      const entries = eventLogRepo.transactional(() => {
        const out = [];
        for (let i = 0; i < 3; i++) {
          out.push(
            eventLogRepo.append({
              event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
              entity_type: "message",
              entity_id: "msg-atomic",
              workspace_id: "ws_events",
              run_id: "run_order",
              caused_by: "user_action",
              payload_json: {
                run_id: "run_order",
                role: "user",
                content: `m${i}`,
                message_id: `msg-atomic-${i}`
              }
            })
          );
        }
        return out;
      });
      expect(entries.map((e) => e.revision)).toEqual([0, 1, 2]);
      // event_ids unique, persisted, queryable
      const persisted = await eventLogRepo.queryByEntity("message", "msg-atomic");
      expect(persisted.map((e) => e.event_id).sort()).toEqual(
        entries.map((e) => e.event_id).sort()
      );
    });

    it("transactional() refuses an async callback (returning a Promise) by throwing", async () => {
      const { eventLogRepo } = await createEventLogRepos();
      // better-sqlite3 itself throws if the wrapped function returns a Promise.
      // We rely on this to prevent silent atomicity loss when callers
      // accidentally pass an async fn.
      expect(() =>
        eventLogRepo.transactional((() =>
          Promise.resolve("nope")) as unknown as () => unknown)
      ).toThrow();
    });
  });
});

async function createEventLogRepos(): Promise<{
  database: ReturnType<typeof initDatabase>;
  workspaceRepo: SqliteWorkspaceRepo;
  runRepo: SqliteRunRepo;
  eventLogRepo: SqliteEventLogRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);

  await workspaceRepo.create({
    workspace_id: "ws_events",
    name: "events",
    root_path: "/tmp/events",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run_order",
    workspace_id: "ws_events",
    title: "ordered run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return { database, workspaceRepo, runRepo, eventLogRepo };
}
