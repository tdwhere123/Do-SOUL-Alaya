import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { RecallService } from "../../recall/recall-service.js";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { vi.restoreAllMocks(); for (const database of databases) database.close(); databases.clear(); });
const fixture = () => createSourceBoundRecallFixture((database) => databases.add(database));
const request = () => ({ taskSurface: createTaskSurface(), workspaceId: "workspace-1",
  strategy: "analyze" as const, queryText: "deployment checklist" });

describe("RecallService conditional entry", () => {
  it("delivers positive raw source evidence without a provider or durable query mutation", async () => {
    const f = await fixture();
    await f.writeMemory("aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "deployment checklist", "procedure");
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider forbidden"));
    const before = f.database.connection.prepare("SELECT COUNT(*) AS count FROM event_log").get();
    const pending = f.pendingGarden();
    const result = await f.service.recall(request());
    expect(result.candidates.map((row) => row.object_id)).toContain("aaaaaaaa-aaaa-4aaa-8aaa-000000000001");
    expect(result.index.entries[0]?.claim).toBe("unknown");
    expect(result.index.completeness.interpretation_coverage).not.toBe("complete");
    expect(f.database.connection.prepare("SELECT COUNT(*) AS count FROM event_log").get()).toEqual(before);
    expect(f.pendingGarden()).toEqual(pending);
    expect(network).not.toHaveBeenCalled();
    expect(result.provider_calls).toBe(0);
  });

  it("keeps unavailable source observation distinct from an observed empty workspace", async () => {
    const f = await fixture();
    const empty = await f.service.recall(request());
    const unavailable = await new RecallService({ ...f.dependencies, observerReaders: {
      snapshotPin: f.dependencies.observerReaders!.snapshotPin
    } }).recall(request());
    expect(empty.candidates).toEqual([]);
    expect(empty.index.completeness.observed_coverage).not.toBe("unavailable");
    expect(unavailable.candidates).toEqual([]);
    expect(unavailable.index.completeness.observed_coverage).toBe("unavailable");
  });

  it("does not invoke retired global candidate merging or recording from target Recall", async () => {
    const f = await fixture();
    await f.writeMemory("aaaaaaaa-aaaa-4aaa-8aaa-000000000002", "deployment checklist", "procedure");
    const recall = vi.fn(async () => { throw new Error("retired merge invoked"); });
    const recordClassifications = vi.fn(async () => { throw new Error("retired mutation invoked"); });
    const result = await new RecallService({ ...f.dependencies,
      globalRecallPort: { recall }, globalRecallCachePort: { recordClassifications } }).recall(request());
    expect(result.candidates).toHaveLength(1);
    expect(recall).not.toHaveBeenCalled();
    expect(recordClassifications).not.toHaveBeenCalled();
  });
});
