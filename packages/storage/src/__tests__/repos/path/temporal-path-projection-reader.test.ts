import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqliteRelationAssertionRepo } from "../../../repos/path/relation-assertion-repo.js";
import {
  SqliteTemporalPathProjectionReader,
  TemporalProjectionGenerationMissingError
} from "../../../repos/path/temporal-path-projection-reader.js";

const BUILD_AS_OF = "2026-08-13T18:57:26.000Z";
const QUESTION_AS_OF = "2023-05-30T23:40:00.000Z";

const databases: StorageDatabase[] = [];

afterEach(() => {
  for (const database of databases) {
    if (!database.isClosed()) database.close();
  }
  databases.length = 0;
});

describe("temporal path projection reader as-of lookup", () => {
  it("rejects a question as-of that has no verified generation", async () => {
    const reader = openReaderWithBuildTimeGeneration();

    await expect(reader.findByWorkspace("workspace-1", { asOf: QUESTION_AS_OF }))
      .rejects.toBeInstanceOf(TemporalProjectionGenerationMissingError);
    await expect(reader.findByWorkspace("workspace-1", { asOf: QUESTION_AS_OF }))
      .rejects.toThrow(/No verified temporal projection exists for as-of 2023-05-30T23:40:00.000Z/);
  });

  it("still serves the verified build-time generation when as-of matches", async () => {
    const reader = openReaderWithBuildTimeGeneration();

    await expect(reader.findByWorkspace("workspace-1", { asOf: BUILD_AS_OF }))
      .resolves.toEqual([]);
  });
});

function openReaderWithBuildTimeGeneration(): SqliteTemporalPathProjectionReader {
  const database = initDatabase({ filename: ":memory:" });
  databases.push(database);
  database.connection.prepare(`
    UPDATE temporal_projection_generations
    SET as_of = ?
    WHERE status = 'verified'
  `).run(BUILD_AS_OF);
  database.connection.prepare(`
    UPDATE temporal_schema_state
    SET active_as_of = ?
    WHERE state_id = 1
  `).run(BUILD_AS_OF);
  return new SqliteTemporalPathProjectionReader(new SqliteRelationAssertionRepo(database));
}
