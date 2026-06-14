import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKind, WorkspaceRunEventType, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";
import { getEventLogWriter, insertEventLogEntry } from "../../../repos/shared/event-log-writer.js";
import { StorageError } from "../../../shared/errors.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function openWriterDb(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "workspace-1",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    default_engine_class: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  return database;
}

function createRunEventDraft(
  entityId: string,
  overrides: Partial<Parameters<typeof insertEventLogEntry>[1]> = {}
): Parameters<typeof insertEventLogEntry>[1] {
  return {
    event_type: WorkspaceRunEventType.RUN_CREATED,
    entity_type: "run",
    entity_id: entityId,
    workspace_id: "workspace-1",
    run_id: entityId,
    caused_by: "user_action",
    payload_json: {
      run_id: entityId,
      workspace_id: "workspace-1",
      title: entityId
    },
    ...overrides
  };
}

describe("event-log writer", () => {
  it("increments revisions per entity while leaving a different entity at revision 0", () => {
    const database = openWriterDb();
    const writer = getEventLogWriter(database.connection);

    const first = insertEventLogEntry(writer, createRunEventDraft("run-1"));
    const second = insertEventLogEntry(writer, createRunEventDraft("run-1"));
    const otherEntity = insertEventLogEntry(writer, createRunEventDraft("run-2"));

    expect([first.revision, second.revision, otherEntity.revision]).toEqual([0, 1, 0]);
    const rows = database.connection
      .prepare(
        `SELECT entity_id, revision
        FROM event_log
        ORDER BY rowid ASC`
      )
      .all() as ReadonlyArray<{ readonly entity_id: string; readonly revision: number }>;
    expect(rows).toEqual([
      { entity_id: "run-1", revision: 0 },
      { entity_id: "run-1", revision: 1 },
      { entity_id: "run-2", revision: 0 }
    ]);
  });

  it("caches one writer per SQLite connection", () => {
    const firstDatabase = openWriterDb();
    const secondDatabase = openWriterDb();

    const firstWriter = getEventLogWriter(firstDatabase.connection);
    expect(getEventLogWriter(firstDatabase.connection)).toBe(firstWriter);
    expect(getEventLogWriter(secondDatabase.connection)).not.toBe(firstWriter);
  });

  it("rolls back earlier inserts when a later event in the same transaction fails validation", () => {
    const database = openWriterDb();
    const writer = getEventLogWriter(database.connection);

    expect(() =>
      database.connection.transaction(() => {
        insertEventLogEntry(writer, createRunEventDraft("run-1"));
        insertEventLogEntry(
          writer,
          // SAFETY: deliberately invalid event_type (not in the draft union) to
          // force runtime validation to reject and roll back the transaction.
          createRunEventDraft("run-1", {
            event_type: "engine.error"
          } as unknown as Partial<Parameters<typeof insertEventLogEntry>[1]>)
        );
      })()
    ).toThrow(StorageError);

    const countRow = database.connection
      .prepare("SELECT COUNT(*) AS total FROM event_log")
      .get() as Readonly<{ readonly total: number }>;
    expect(countRow.total).toBe(0);
  });
});
