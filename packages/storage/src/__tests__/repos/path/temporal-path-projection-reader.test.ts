import { afterEach, describe, expect, it } from "vitest";
import {
  createTimeConcernWindowDigest,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqliteRelationAssertionRepo } from "../../../repos/path/relation-assertion-repo.js";
import { SqliteTemporalPathProjectionReader } from "../../../repos/path/temporal-path-projection-reader.js";

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
      .rejects.toMatchObject({
        name: "TemporalProjectionGenerationMissingError",
        code: "NOT_FOUND",
        message: expect.stringMatching(
          /No verified temporal projection exists for as-of 2023-05-30T23:40:00.000Z/
        )
      });
  });

  it("still serves the verified build-time generation when as-of matches", async () => {
    const reader = openReaderWithBuildTimeGeneration();

    await expect(reader.findByWorkspace("workspace-1", { asOf: BUILD_AS_OF }))
      .resolves.toEqual([]);
  });

  it("matches canonical time concern intervals by overlap", async () => {
    const path = {
      anchors: {
        source_anchor: { kind: "object", object_id: "memory-1" },
        target_anchor: {
          kind: "time_concern",
          source_object_id: "memory-1",
          window_digest: createTimeConcernWindowDigest(
            "2026-03-19T00:00:00.000Z",
            "2026-03-19T23:59:59.999Z"
          )
        }
      }
    } as PathRelation;
    const reader = new SqliteTemporalPathProjectionReader({
      findActiveProjectionByWorkspace: async () => [path],
      findProjectionByWorkspaceAtAsOf: async () => [path]
    });

    await expect(reader.findByTimeConcernWindowDigests("workspace-1", [
      createTimeConcernWindowDigest(
        "2026-03-01T00:00:00.000Z",
        "2026-03-31T23:59:59.999Z"
      )
    ])).resolves.toEqual([path]);
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
