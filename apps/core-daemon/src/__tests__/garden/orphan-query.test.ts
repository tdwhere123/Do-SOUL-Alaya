import { afterEach, describe, expect, it } from "vitest";
import {
  TrustStateEventType,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteOrphanRadarRepo,
  SqliteWorkspaceRepo,
  type EventLogAppendInput
} from "@do-soul/alaya-storage";
import { findEventLogOrphansForWorkspace } from "../../garden/orphan-query.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("orphan query", () => {
  it("detects trust EventLog rows missing their durable trust table row", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const orphanRadarRepo = new SqliteOrphanRadarRepo(database);

    await workspaceRepo.create({
      workspace_id: "workspace-1",
      name: "workspace one",
      root_path: "/tmp/ws1",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    const deliveryEvent = await eventLogRepo.append({
      event_type: TrustStateEventType.MEMORY_DELIVERED,
      entity_type: "trust_context_delivery",
      entity_id: "delivery-1",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "codex",
      revision: 0,
      payload_json: {}
    } as EventLogAppendInput);
    const usageEvent = await eventLogRepo.append({
      event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
      entity_type: "trust_usage_proof",
      entity_id: "delivery-1",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "codex",
      revision: 0,
      payload_json: {}
    } as EventLogAppendInput);
    await eventLogRepo.append({
      event_type: TrustStateEventType.TRUST_STATE_INSTALLED_RECORDED,
      entity_type: "trust_state_counter",
      entity_id: "codex:installed",
      workspace_id: "trust-state",
      run_id: null,
      caused_by: "codex",
      revision: 0,
      payload_json: { agent_target: "codex", counter_name: "installed" }
    } as EventLogAppendInput);

    database.connection
      .prepare("UPDATE event_log SET created_at = ? WHERE event_id IN (?, ?)")
      .run("2000-01-01T00:00:00.000Z", deliveryEvent.event_id, usageEvent.event_id);

    await expect(findEventLogOrphansForWorkspace(database.connection, "workspace-1")).resolves.toEqual(
      expect.arrayContaining([
        {
          audit_event_id: deliveryEvent.event_id,
          event_type: TrustStateEventType.MEMORY_DELIVERED,
          expected_table: "trust_context_delivery",
          detected_at: "2000-01-01T00:00:00.000Z"
        },
        {
          audit_event_id: usageEvent.event_id,
          event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
          expected_table: "trust_usage_proof",
          detected_at: "2000-01-01T00:00:00.000Z"
        }
      ])
    );
    await expect(findEventLogOrphansForWorkspace(database.connection, "workspace-1")).resolves.toHaveLength(2);

    await orphanRadarRepo.createEventLogOrphan({
      radar_id: "radar-usage",
      audit_event_id: usageEvent.event_id,
      event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
      expected_table: "trust_usage_proof",
      workspace_id: "workspace-1",
      detected_at: "2026-05-01T00:00:00.000Z",
      expires_at: "2026-05-03T00:00:00.000Z",
      requires_review: true
    });

    await expect(findEventLogOrphansForWorkspace(database.connection, "workspace-1")).resolves.toEqual([
      {
        audit_event_id: deliveryEvent.event_id,
        event_type: TrustStateEventType.MEMORY_DELIVERED,
        expected_table: "trust_context_delivery",
        detected_at: "2000-01-01T00:00:00.000Z"
      }
    ]);
  });
});
