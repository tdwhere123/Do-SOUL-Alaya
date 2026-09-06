import { describe, expect, it } from "vitest";
import { assertTargetConsumer } from "./consumer-contract.js";
import {
  coverageIndex,
  sqliteCancelledWorker,
  sqliteInterruptedZero,
  sqliteMixedGeneration,
  sqliteNormalEntryCounters,
  sqliteTombstoneRestart,
  stubCliRecall,
  stubMcpRecall
} from "./frozen-entry.js";

describe("conditional-field source and worker acceptance fixtures", () => {
  it("A09 interrupted zero rows stay open and resumable, not known-empty", () => {
    const fixture = sqliteInterruptedZero();
    expect(fixture.reader.ids).toEqual([]);
    expect(fixture.reader.truncated).toBe(true);
    expect(fixture.reader.available).toBe(true);
    const index = coverageIndex("interrupted", "open");
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
    const resumed = coverageIndex("interrupted", "open");
    expect(resumed.completeness.observed_coverage).toBe(index.completeness.observed_coverage);
  });

  it("A18 hides tombstones and keeps the current source after restart", () => {
    const fixture = sqliteTombstoneRestart();
    const live = fixture.rows.filter((row) => row.retention === "live").map((row) => row.object_id);
    expect(live).not.toContain("u");
    expect(live).toContain("r");
    const restarted = { ...fixture, rows: fixture.rows.map((row) => ({ ...row })) };
    expect(restarted.rows.find((row) => row.object_id === "u")?.retention).toBe("tombstoned");
    expect(restarted.rows.find((row) => row.object_id === "r")?.source_revision).toBe("src-r");
  });

  it("A18 mixed generations cannot resume an old complete page", () => {
    const fixture = sqliteMixedGeneration();
    expect(new Set(fixture.rows.map((row) => row.generation_id)).size).toBeGreaterThan(1);
    const index = coverageIndex("invalidated", "invalidated");
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(index.continuation).toBeNull();
  });

  it("maps worker cancellation off the complete-empty path", () => {
    const fixture = sqliteCancelledWorker();
    expect(fixture.worker).toBe("cancelled");
    const index = coverageIndex("cancelled", "open");
    const mcp = stubMcpRecall(index);
    expect(assertTargetConsumer(mcp)).toEqual([]);
    expect(mcp.index.completeness.observed_coverage).toBe("cancelled");
    expect(mcp.index.completeness.logical_index).not.toBe("complete");
  });

  it("normal-entry provider and garden counters stay at zero", () => {
    const fixture = sqliteNormalEntryCounters();
    const mcp = stubMcpRecall(coverageIndex("complete", "complete"));
    const cli = stubCliRecall(mcp.index);
    expect(fixture.provider_calls).toBe(0);
    expect(fixture.garden_enqueue).toBe(0);
    expect(mcp.provider_calls).toBe(0);
    expect(cli.garden_enqueue).toBe(0);
    expect(assertTargetConsumer(mcp)).toEqual([]);
    expect(assertTargetConsumer(cli)).toEqual([]);
  });
});
