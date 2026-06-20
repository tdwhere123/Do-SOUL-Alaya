import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceRunEventType,
  TrustStateEventType,
  WorkspaceKind
} from "@do-soul/alaya-protocol";
import { createEventLogRepos, trackedDatabases } from "./event-log-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteEventLogRepo cursor and usage queries", () => {
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



});
