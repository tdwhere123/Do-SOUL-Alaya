import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { assertTargetConsumer } from "./consumer-contract.js";
import {
  MEM,
  WS,
  defaultBudget,
  openBoundSlice,
  plantDeployment,
  plantNeedles,
  readersFor,
  recallThroughHandler,
  runRecall,
  toConsumer,
  tombstone
} from "./planted-handler.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field source and worker acceptance", () => {
  it("interrupted zero rows stay open and resumable, not known-empty", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const inner = readersFor(slice);
    const interrupted = {
      ...inner,
      lexical: (input: Parameters<NonNullable<typeof inner.lexical>>[0]) =>
        inner.lexical!({ ...input, limit: 0, nativeLimit: 0 })
    };
    const first = runRecall(slice, { readers: interrupted });
    const resumed = runRecall(slice, { readers: interrupted, continuation: first.continuation });
    expect(first.entries).toEqual([]);
    expect(first.completeness.logical_index).not.toBe("complete");
    expect(first.completeness.observed_coverage).not.toBe("exhausted_empty");
    expect(resumed.completeness.observed_coverage).not.toBe("exhausted_empty");
  });

  it("hides tombstones and keeps the current source after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conditional-field-accept-a18-"));
    const filename = join(directory, "source.sqlite");
    const first = await openBoundSlice((database) => databases.add(database), filename);
    await plantDeployment(first);
    tombstone(first, MEM.u);
    const hidden = await recallThroughHandler(first, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expect(hidden.index.entries.map((entry) => entry.object_id)).not.toContain(MEM.u);
    expect(first.memoryReader.source(WS, MEM.r).unavailable).toBe(false);
    expect(first.indexProjection.freshness(WS, MEM.u).lexical).toBe("tombstoned");
    first.database.close();
    databases.delete(first.database);
    const reopened = await openBoundSlice((database) => databases.add(database), filename);
    const restarted = await recallThroughHandler(reopened, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expect(restarted.index.entries.map((entry) => entry.object_id)).not.toContain(MEM.u);
    expect(reopened.memoryReader.source(WS, MEM.r).unavailable).toBe(false);
    reopened.database.close();
    databases.delete(reopened.database);
    rmSync(directory, { recursive: true, force: true });
  });

  it("mixed generations cannot resume an old complete page", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantNeedles(slice, 8, 911);
    const first = await recallThroughHandler(slice, {
      query: "needle",
      max_results: 1
    });
    expect(first.index.continuation).not.toBeNull();
    const mixed = runRecall(slice, {
      query_text: "needle",
      budget: defaultBudget({ page_budget: 1 }),
      continuation: first.index.continuation,
      snapshot_id: `sha256:${"e".repeat(64)}`
    });
    expect(mixed.completeness.logical_index).not.toBe("complete");
    expect(mixed.completeness.observed_coverage).toBe("invalidated");
    expect(mixed.continuation).toBeNull();
  });

  it("maps worker cancellation off the complete-empty path", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const index = runRecall(slice, { cancelled: true });
    expect(index.completeness.observed_coverage).toBe("cancelled");
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(assertTargetConsumer({
      schema_version: 1,
      surface: "mcp",
      bound: true,
      note: "real producer",
      query_id: index.query_id,
      snapshot_id: index.snapshot_id,
      result_version: index.result_version,
      provider_calls: 0,
      garden_enqueue: 0,
      index
    })).toEqual([]);
  });

  it("normal-entry provider and garden counters stay at zero", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const before = slice.pendingGarden().length;
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expect(slice.pendingGarden()).toHaveLength(before);
    expect(assertTargetConsumer(toConsumer(mcp, "mcp"))).toEqual([]);
  });
});
