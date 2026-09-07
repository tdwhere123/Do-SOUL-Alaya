import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { MEM, WS } from "../conditional-field/vertical/source-slice.js";
import {
  openBoundSlice,
  plantDeployment,
  plantNeedles,
  readersFor,
  runRecall,
  tombstone
} from "./bound-producer.js";
import { defaultBudget } from "./finite-worlds.js";
import { unboundPorts } from "./frozen-ports.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field source lifecycle oracle", () => {
  it("hides tombstones and keeps the current source after a restart snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conditional-field-oracle-a18-"));
    const filename = join(directory, "source.sqlite");
    const first = await openBoundSlice((database) => databases.add(database), filename);
    await plantDeployment(first);
    tombstone(first, MEM.u);
    const hidden = runRecall(first);
    expect(hidden.entries.map((entry) => entry.object_id)).not.toContain(MEM.u);
    expect(first.memoryReader.source(WS, MEM.r).unavailable).toBe(false);
    expect(first.indexProjection.freshness(WS, MEM.u).lexical).toBe("tombstoned");
    first.database.close();
    databases.delete(first.database);
    const reopened = await openBoundSlice((database) => databases.add(database), filename);
    const restarted = runRecall(reopened);
    expect(restarted.entries.map((entry) => entry.object_id)).not.toContain(MEM.u);
    const live = reopened.memoryReader.source(WS, MEM.r);
    expect(live.unavailable).toBe(false);
    expect(live.row?.object_id).toBe(MEM.r);
    expect(reopened.indexProjection.freshness(WS, MEM.u).lexical).toBe("tombstoned");
    reopened.database.close();
    databases.delete(reopened.database);
    rmSync(directory, { recursive: true, force: true });
  });

  it("invalidates mixed-generation coverage instead of minting a complete index", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantNeedles(slice, 8, 901);
    const first = runRecall(slice, {
      query_text: "needle",
      budget: defaultBudget({ page_budget: 1 })
    });
    expect(first.continuation).not.toBeNull();
    const mixed = runRecall(slice, {
      query_text: "needle",
      budget: defaultBudget({ page_budget: 1 }),
      continuation: first.continuation,
      snapshot_id: `sha256:${"d".repeat(64)}`
    });
    expect(mixed.completeness.logical_index).not.toBe("complete");
    expect(mixed.completeness.observed_coverage).toBe("invalidated");
  });

  it("maps worker cancellation to cancelled coverage, not complete empty", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const index = runRecall(slice, { cancelled: true });
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(index.completeness.observed_coverage).toBe("cancelled");
    expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
  });

  it("keeps interrupted resumable coverage open across a pinned snapshot", async () => {
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
    expect(first.completeness.observed_coverage).not.toBe("exhausted_empty");
    expect(first.completeness.logical_index).not.toBe("complete");
    expect(resumed.completeness.observed_coverage).not.toBe("exhausted_empty");
  });

  it("normal-entry counters stay at zero while unbound production rows fail", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const before = slice.pendingGarden().length;
    runRecall(slice);
    expect(slice.pendingGarden()).toHaveLength(before);
    expect(unboundPorts().bound).toBe(false);
  });
});
