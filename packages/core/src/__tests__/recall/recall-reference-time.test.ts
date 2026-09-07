import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });
const fixture = () => createSourceBoundRecallFixture((database) => databases.add(database));
const request = () => ({ taskSurface: createTaskSurface(), workspaceId: "workspace-1",
  strategy: "analyze" as const, queryText: "deployment checklist" });

describe("RecallService explicit query time", () => {
  it("filters real source timestamps with explicit inclusive bounds and keeps the interpretation clock", async () => {
    const f = await fixture();
    const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
      "aaaaaaaa-aaaa-4aaa-8aaa-000000000003"];
    const dates = ["2026-08-21T23:59:59.000Z", "2026-08-22T12:00:00.000Z", "2026-08-23T00:00:00.000Z"];
    for (const [offset, objectId] of ids.entries()) {
      await f.writeSource({ objectId, content: "deployment checklist", createdAt: dates[offset]! });
    }
    const result = await f.service.recall({ ...request(), referenceTime: "2026-08-24T12:00:00.000Z",
      timeFilter: { field: "created_at", since: "2026-08-22T00:00:00.000Z", until: "2026-08-23T00:00:00.000Z" } });
    expect(result.candidates.map((entry) => entry.object_id)).toEqual([ids[1], ids[2]]);
    expect(result.index.as_of).toBe("2026-08-24T12:00:00.000Z");
  });

  it("preserves the reference-time fixed offset while binding the same physical instant", async () => {
    const f = await fixture();
    await f.writeSource({ objectId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      content: "deployment checklist", createdAt: "2026-08-22T17:00:00.000Z" });
    const utc = await f.service.recall({ ...request(), referenceTime: "2026-08-22T16:00:00.000Z" });
    const offset = await f.service.recall({ ...request(), referenceTime: "2026-08-23T00:00:00.000+08:00" });
    expect(utc.candidates).toHaveLength(1);
    expect(offset.candidates.map((entry) => entry.object_id)).toEqual(utc.candidates.map((entry) => entry.object_id));
  });

  it("rejects malformed reference clocks before publishing source claims", async () => {
    const f = await fixture();
    for (const referenceTime of ["not-a-date", "2026-08-23T00:30:00"]) {
      await expect(f.service.recall({ ...request(), referenceTime })).rejects.toThrow();
    }
  });

  it("preserves query and snapshot identity while resuming with the original reference clock", async () => {
    const f = await fixture();
    for (let offset = 0; offset < 3; offset += 1) {
      await f.writeSource({ objectId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(offset).padStart(12, "0")}`,
        content: "deployment checklist", createdAt: "2026-08-22T12:00:00.000Z" });
    }
    const first = await f.service.recall({ ...request(), pageBudget: 1, referenceTime: "2026-08-24T12:00:00.000Z" });
    expect(first.index.continuation).not.toBeNull();
    const resumed = await f.service.recall({ ...request(), pageBudget: 1, continuation: first.index.continuation });
    expect(resumed.index.as_of).toBe(first.index.as_of);
    expect(resumed.index.query_id).toBe(first.index.query_id);
    expect(resumed.index.snapshot_id).toBe(first.index.snapshot_id);
  });
});
