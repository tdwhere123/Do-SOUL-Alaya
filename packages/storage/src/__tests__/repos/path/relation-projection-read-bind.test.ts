import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import {
  isLegacyPathIndexUnbound,
  isRelationProjectionReadable
} from "../../../repos/path/relation-assertion/projection-reader.js";

const databases: StorageDatabase[] = [];

afterEach(() => {
  for (const database of databases) {
    if (!database.isClosed()) database.close();
  }
  databases.length = 0;
});

describe("relation projection read bind", () => {
  it("treats a ready unselected bootstrap as readable but not an unbound legacy miss", () => {
    const database = openMemory();
    expect(isRelationProjectionReadable(database)).toBe(true);
    expect(isLegacyPathIndexUnbound(database)).toBe(false);
  });

  it("names an empty legacy table unbound only when a populated projection is ready", () => {
    const database = openMemory();
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET projection_count = 1
      WHERE state_id = 1
    `).run();
    expect(isRelationProjectionReadable(database)).toBe(true);
    expect(isLegacyPathIndexUnbound(database)).toBe(true);
  });
});

function openMemory(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  databases.push(database);
  return database;
}
