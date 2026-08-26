import { afterEach, describe, expect, it } from "vitest";
import {
  createTimeConcernWindowDigest,
  serializePathAnchorRef,
  type PathAnchorRef,
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

describe("temporal path projection reader parse cache", () => {
  it("loads the active projection once across disjoint findByAnchors hops", async () => {
    const pathBySource = objectPath("memory-a", "memory-x");
    const pathByTarget = objectPath("memory-y", "memory-b");
    const unrelated = objectPath("memory-c", "memory-d");
    const universe = [pathBySource, pathByTarget, unrelated];
    const repo = countingProjectionRepo(universe);
    const reader = new SqliteTemporalPathProjectionReader(repo);
    const sourceAnchor = objectAnchor("memory-a");
    const targetAnchor = objectAnchor("memory-b");

    const bySource = await reader.findByAnchors("workspace-1", [sourceAnchor]);
    const byTarget = await reader.findByAnchors("workspace-1", [targetAnchor]);

    expect(repo.activeCalls).toBe(1);
    expect(bySource).toEqual(filterByAnchors(universe, [sourceAnchor]));
    expect(byTarget).toEqual(filterByAnchors(universe, [targetAnchor]));
  });

  it("shares the cached projection between findByWorkspace and findByAnchors", async () => {
    const matching = objectPath("memory-a", "memory-x");
    const other = objectPath("memory-c", "memory-d");
    const repo = countingProjectionRepo([matching, other]);
    const reader = new SqliteTemporalPathProjectionReader(repo);
    const anchor = objectAnchor("memory-a");

    const viaWorkspace = await reader.findByWorkspace("workspace-1");
    const viaAnchors = await reader.findByAnchors("workspace-1", [anchor]);
    const viaWorkspaceAgain = await reader.findByWorkspace("workspace-1");

    expect(repo.activeCalls).toBe(1);
    expect(viaWorkspaceAgain).toBe(viaWorkspace);
    expect(viaAnchors).toEqual(filterByAnchors(viaWorkspace, [anchor]));
  });

  it("does not let a missing as-of lookup poison a later active read", async () => {
    const activePath = objectPath("memory-a", "memory-x");
    const repo = countingProjectionRepo([activePath], { asOfResult: null });
    const reader = new SqliteTemporalPathProjectionReader(repo);

    await expect(reader.findByWorkspace("workspace-1", { asOf: QUESTION_AS_OF }))
      .rejects.toMatchObject({
        name: "TemporalProjectionGenerationMissingError",
        code: "NOT_FOUND"
      });
    await expect(reader.findByWorkspace("workspace-1", { asOf: QUESTION_AS_OF }))
      .rejects.toMatchObject({ name: "TemporalProjectionGenerationMissingError" });

    const active = await reader.findByWorkspace("workspace-1");

    expect(repo.asOfCalls).toBe(2);
    expect(repo.activeCalls).toBe(1);
    expect(active).toEqual([activePath]);
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

function objectAnchor(objectId: string): PathAnchorRef {
  return { kind: "object", object_id: objectId };
}

function objectPath(sourceId: string, targetId: string): PathRelation {
  return {
    anchors: {
      source_anchor: objectAnchor(sourceId),
      target_anchor: objectAnchor(targetId)
    }
  } as PathRelation;
}

function filterByAnchors(
  paths: readonly PathRelation[],
  anchorRefs: readonly PathAnchorRef[]
): PathRelation[] {
  const anchorKeys = new Set(anchorRefs.map(serializePathAnchorRef));
  return paths.filter((path) =>
    anchorKeys.has(serializePathAnchorRef(path.anchors.source_anchor)) ||
    anchorKeys.has(serializePathAnchorRef(path.anchors.target_anchor))
  );
}

function countingProjectionRepo(
  paths: readonly PathRelation[],
  options: { readonly asOfResult?: readonly PathRelation[] | null } = {}
) {
  let activeCalls = 0;
  let asOfCalls = 0;
  return {
    get activeCalls() {
      return activeCalls;
    },
    get asOfCalls() {
      return asOfCalls;
    },
    findActiveProjectionByWorkspace: async () => {
      activeCalls += 1;
      return paths.slice();
    },
    findProjectionByWorkspaceAtAsOf: async () => {
      asOfCalls += 1;
      return options.asOfResult ?? null;
    }
  };
}
