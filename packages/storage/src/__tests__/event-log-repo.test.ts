import { afterEach, describe, expect, it } from "vitest";
import {
  Phase0EventType,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteEventLogRepo } from "../repos/event-log-repo.js";
import { SqliteRunRepo } from "../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

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
      event_type: Phase0EventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
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
      event_type: Phase0EventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run_target",
      workspace_id: "ws_events",
      run_id: "run_target",
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        run_id: "run_target",
        workspace_id: "ws_events",
        run_mode: RunMode.CHAT,
        title: "target"
      }
    });
    await eventLogRepo.append({
      event_type: Phase0EventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run_other",
      workspace_id: "ws_events",
      run_id: "run_other",
      caused_by: "user_action",
      revision: 0,
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
      event_type: Phase0EventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_match",
      workspace_id: "ws_match",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        workspace_id: "ws_match",
        name: "match",
        workspace_kind: WorkspaceKind.DOCS_ONLY
      }
    });
    await eventLogRepo.append({
      event_type: Phase0EventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_other",
      workspace_id: "ws_other",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
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
      event_type: Phase0EventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_type",
      workspace_id: "ws_type",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        workspace_id: "ws_type",
        name: "type",
        workspace_kind: WorkspaceKind.MIXED
      }
    });
    await eventLogRepo.append({
      event_type: Phase0EventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run_type",
      workspace_id: "ws_type",
      run_id: "run_type",
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        run_id: "run_type",
        workspace_id: "ws_type",
        run_mode: RunMode.REVIEW,
        title: "type"
      }
    });

    const events = await eventLogRepo.queryByType(Phase0EventType.RUN_CREATED);

    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe(Phase0EventType.RUN_CREATED);
  });

  it("returns multiple matching events in append order", async () => {
    const { eventLogRepo } = await createEventLogRepos();
    await eventLogRepo.append({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "hello",
        message_id: "msg_1"
      }
    });
    await eventLogRepo.append({
      event_type: Phase0EventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "engine",
      revision: 1,
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
      Phase0EventType.RUN_MESSAGE_APPENDED,
      Phase0EventType.ENGINE_RESPONSE_RECEIVED
    ]);
  });

  it("queryByRunAfterEventId returns only events after the target event ID", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    const first = await eventLogRepo.append({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "first",
        message_id: "msg_1"
      }
    });
    await eventLogRepo.append({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      revision: 1,
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "second",
        message_id: "msg_2"
      }
    });
    await eventLogRepo.append({
      event_type: Phase0EventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "engine",
      revision: 2,
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
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "hello",
        message_id: "msg_1"
      }
    });
    await eventLogRepo.append({
      event_type: Phase0EventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "engine",
      revision: 1,
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
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "first",
        message_id: "msg_1"
      }
    });
    const second = await eventLogRepo.append({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      revision: 1,
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "second",
        message_id: "msg_2"
      }
    });
    const third = await eventLogRepo.append({
      event_type: Phase0EventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "engine",
      revision: 2,
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
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        run_id: "run_order",
        role: "user",
        content: "first",
        message_id: "msg_1"
      }
    });
    const second = await eventLogRepo.append({
      event_type: Phase0EventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "run",
      entity_id: "run_order",
      workspace_id: "ws_events",
      run_id: "run_order",
      caused_by: "engine",
      revision: 1,
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


  it("queryByWorkspace returns only matching workspace events", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    await eventLogRepo.append({
      event_type: Phase0EventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        workspace_id: "ws_events",
        name: "events",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    });
    await eventLogRepo.append({
      event_type: Phase0EventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_other",
      workspace_id: "ws_other",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
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
      event_type: Phase0EventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        workspace_id: "ws_events",
        name: "events",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    });

    await eventLogRepo.append({
      event_type: Phase0EventType.WORKSPACE_DELETED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      revision: 1,
      payload_json: {
        workspace_id: "ws_events"
      }
    });

    const replay = await eventLogRepo.queryByWorkspaceAfterEventId("ws_events", first.event_id);

    expect(replay).toHaveLength(1);
    expect(replay[0]?.event_type).toBe(Phase0EventType.WORKSPACE_DELETED);
  });

  it("getLatestWorkspaceEventId returns the latest workspace event", async () => {
    const { eventLogRepo } = await createEventLogRepos();

    await eventLogRepo.append({
      event_type: Phase0EventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        workspace_id: "ws_events",
        name: "events",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    });

    const deleted = await eventLogRepo.append({
      event_type: Phase0EventType.WORKSPACE_DELETED,
      entity_type: "workspace",
      entity_id: "ws_events",
      workspace_id: "ws_events",
      run_id: null,
      caused_by: "user_action",
      revision: 1,
      payload_json: {
        workspace_id: "ws_events"
      }
    });

    await expect(eventLogRepo.getLatestWorkspaceEventId("ws_events")).resolves.toBe(deleted.event_id);
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
