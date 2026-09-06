import { describe, expect, it } from "vitest";
import { enumerateSimplePaths } from "./enumerate-simple-paths.js";
import {
  QUERY_ID,
  RESULT_VERSION,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView,
  deploymentWorld,
  sqliteCancelledWorker,
  sqliteInterruptedZero,
  sqliteMixedGeneration,
  sqliteNormalEntryCounters,
  sqliteTombstoneRestart,
  type SqliteSourceFixture
} from "./finite-worlds.js";
import { contractOnlyPorts, unboundPorts } from "./frozen-ports.js";
import {
  mapNativeReaderPage,
  milligradeOf,
  projectOracleIndex
} from "./oracle-index.js";

describe("conditional-field source lifecycle oracle", () => {
  it("A18 hides tombstones and keeps the current source after a restart snapshot", () => {
    const fixture = sqliteTombstoneRestart();
    const visible = liveObjectIds(fixture);
    expect(visible).not.toContain("u");
    expect(visible).toEqual(["r", "l", "c", "s", "h"]);
    const restarted = replayFixture(fixture);
    expect(restarted.rows.find((row) => row.object_id === "u")?.retention).toBe("tombstoned");
    expect(restarted.rows.find((row) => row.object_id === "r")?.retention).toBe("live");
    expect(restarted.rows.find((row) => row.object_id === "r")?.source_revision).toBe("src-r");
    const world = deploymentWorld();
    const field = enumerateSimplePaths(
      world.seeds,
      world.edges.filter((edge) => visible.includes(edge.to.object_id) || edge.to.object_id === "r")
    );
    expect(milligradeOf(field, "u")).toBe(0);
    expect(milligradeOf(field, "c")).toBe(850);
  });

  it("A18 invalidates mixed-generation coverage instead of minting a complete index", () => {
    const fixture = sqliteMixedGeneration();
    const generations = new Set(fixture.rows.map((row) => row.generation_id));
    expect(generations.size).toBeGreaterThan(1);
    const index = projectOracleIndex({
      field: enumerateSimplePaths([], []),
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: new Map(),
      prior_continuation: {
        schema_version: 1,
        continuation_id: "page-1",
        query_id: QUERY_ID,
        snapshot_id: `sha256:${"d".repeat(64)}`,
        result_version: RESULT_VERSION,
        expires_at: "2099-01-01T00:00:00.000Z",
        cursor: "offset-1"
      }
    });
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(index.completeness.observed_coverage).toBe("invalidated");
  });

  it("maps worker cancellation to cancelled coverage, not complete empty", () => {
    const fixture = sqliteCancelledWorker();
    expect(fixture.worker).toBe("cancelled");
    const observer = mapNativeReaderPage(fixture.reader);
    const index = projectOracleIndex({
      field: enumerateSimplePaths([], []),
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: new Map(),
      observer: {
        outcome: { schema_version: 1, status: "cancelled" },
        open_regions: observer.open_regions
      }
    });
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(index.completeness.observed_coverage).toBe("cancelled");
    expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
  });

  it("keeps interrupted resumable coverage open across a pinned snapshot", () => {
    const fixture = sqliteInterruptedZero();
    const first = mapNativeReaderPage(fixture.reader);
    const resumed = mapNativeReaderPage(fixture.reader);
    expect(first.outcome.status).toBe("interrupted");
    expect(resumed.outcome.status).toBe("interrupted");
    expect(first.open_regions.map((region) => region.kind)).toEqual(resumed.open_regions.map((region) => region.kind));
  });

  it("A17-shaped normal-entry counters stay at zero while optional semantics are missing", () => {
    const fixture = sqliteNormalEntryCounters();
    const ports = contractOnlyPorts();
    expect(fixture.provider_calls).toBe(0);
    expect(fixture.garden_enqueue).toBe(0);
    expect(ports.providerCalls?.()).toBe(0);
    expect(ports.gardenEnqueue?.()).toBe(0);
    expect(unboundPorts().bound).toBe(false);
  });
});

function liveObjectIds(fixture: SqliteSourceFixture): readonly string[] {
  return fixture.rows.filter((row) => row.retention === "live").map((row) => row.object_id);
}

function replayFixture(fixture: SqliteSourceFixture): SqliteSourceFixture {
  return {
    ...fixture,
    rows: fixture.rows.map((row) => ({ ...row }))
  };
}
