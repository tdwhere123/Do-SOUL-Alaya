import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceRunEventType,
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

describe("SqliteEventLogRepo workspace and transaction queries", () => {
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

  it("queryByWorkspacePage preserves full workspace history while exposing bounded windows", async () => {
    const { eventLogRepo } = await createEventLogRepos();
    for (const eventType of [
      WorkspaceRunEventType.WORKSPACE_CREATED,
      WorkspaceRunEventType.WORKSPACE_ENGINE_BINDING_UPDATED,
      WorkspaceRunEventType.WORKSPACE_DELETED
    ]) {
      await eventLogRepo.append({
        event_type: eventType,
        entity_type: "workspace",
        entity_id: "ws_paged",
        workspace_id: "ws_paged",
        run_id: null,
        caused_by: "user_action",
        payload_json: {
          workspace_id: "ws_paged",
          name: "paged",
          workspace_kind: WorkspaceKind.LOCAL_REPO
        }
      });
    }

    await expect(eventLogRepo.queryByWorkspace("ws_paged")).resolves.toHaveLength(3);
    await expect(eventLogRepo.queryByWorkspacePage?.("ws_paged", { limit: 1, offset: 2 })).resolves.toMatchObject([
      { event_type: WorkspaceRunEventType.WORKSPACE_DELETED }
    ]);
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
