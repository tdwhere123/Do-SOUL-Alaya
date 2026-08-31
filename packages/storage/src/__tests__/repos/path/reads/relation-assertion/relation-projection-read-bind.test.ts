import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "../../../../../sqlite/db.js";
import {
  isLegacyPathIndexUnbound,
  isRelationProjectionReadable
} from "../../../../../repos/path/reads/relation-assertion/projection-reader.js";

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

  it("rejects a populated state whose active projection row count is inconsistent", () => {
    const database = openMemory();
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET projection_count = 1
      WHERE state_id = 1
    `).run();
    expect(() => isRelationProjectionReadable(database)).toThrow(
      "active generation is missing or inconsistent"
    );
    expect(() => isLegacyPathIndexUnbound(database)).toThrow(
      "active generation is missing or inconsistent"
    );
  });

  it("names a refresh-required ready projection unbound when legacy is empty", () => {
    const database = openMemory();
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET projection_refresh_required = 1, projection_count = 1
      WHERE state_id = 1
    `).run();
    expect(isRelationProjectionReadable(database)).toBe(false);
    expect(isLegacyPathIndexUnbound(database)).toBe(true);
  });

  it("rejects a ready state whose active generation is missing", () => {
    const database = openMemory();
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET active_projection_generation = 'missing-generation'
      WHERE state_id = 1
    `).run();

    expect(() => isRelationProjectionReadable(database)).toThrow(
      "active generation is missing or inconsistent"
    );
    expect(() => isLegacyPathIndexUnbound(database)).toThrow(
      "active generation is missing or inconsistent"
    );
  });
});

function openMemory(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  databases.push(database);
  return database;
}
