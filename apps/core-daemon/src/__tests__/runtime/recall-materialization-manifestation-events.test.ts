import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRunEventType, type EventLogEntry } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createAtomicManifestationEventLogWriter } from "../../runtime/recall-materialization-wiring.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("manifestation EventLog adapter", () => {
  it("rolls back the whole batch when a later append fails", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const append = eventLogRepo.append.bind(eventLogRepo);
    let appendCount = 0;
    vi.spyOn(eventLogRepo, "append").mockImplementation((entry) => {
      appendCount += 1;
      if (appendCount === 2) {
        throw new Error("synthetic manifestation append failure");
      }
      return append(entry);
    });

    const writer = createAtomicManifestationEventLogWriter(eventLogRepo);
    expect(() => writer.appendAtomically([
      workspaceCreatedEntry("manifestation-ws-1"),
      workspaceCreatedEntry("manifestation-ws-2")
    ])).toThrow("synthetic manifestation append failure");

    await expect(
      eventLogRepo.queryByEntity("workspace", "manifestation-ws-1")
    ).resolves.toEqual([]);
  });
});

function workspaceCreatedEntry(
  workspaceId: string
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
    entity_type: "workspace",
    entity_id: workspaceId,
    workspace_id: workspaceId,
    run_id: null,
    caused_by: "deterministic_rule",
    payload_json: { workspace_id: workspaceId, name: workspaceId, workspace_kind: "local_repo" }
  };
}
