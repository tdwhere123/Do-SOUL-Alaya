import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";
import { MEM, WS } from "./conditional-field/vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("conditional source governance admission", () => {
  it("applies source-owned tag filters with a positive admitted source", async () => {
    const f = await createSourceBoundRecallFixture((database) => databases.add(database));
    await f.writeSource({ objectId: MEM.r, content: "Atlas deployment accepted", domainTags: ["allowed"] });
    await f.writeSource({ objectId: MEM.u, content: "Atlas deployment excluded", domainTags: ["other"] });
    const base = f.service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const result = await f.service.recall({
      taskSurface: { ...createTaskSurface(), display_name: "Atlas deployment" }, workspaceId: WS, strategy: "analyze",
      policyOverride: { ...base, coarse_filter: { ...base.coarse_filter,
        deterministic_match: { ...base.coarse_filter.deterministic_match, domain_tag_filter: ["allowed"] } } }
    });
    expect(result.candidates.map((row) => row.object_id)).toEqual([MEM.r]);
    expect(result.index?.entries.some((row) => row.object_id === MEM.u)).toBe(false);
  });

  it("revokes a tombstoned source without suppressing another admitted source", async () => {
    const f = await createSourceBoundRecallFixture((database) => databases.add(database));
    await f.writeMemory(MEM.r, "Atlas deployment accepted", MemoryDimension.FACT);
    await f.writeMemory(MEM.u, "Atlas deployment hidden secret", MemoryDimension.FACT);
    f.database.connection.prepare("UPDATE memory_entries SET retention_state = 'tombstoned' WHERE object_id = ?").run(MEM.u);
    const result = await f.service.recall({ taskSurface: { ...createTaskSurface(), display_name: "Atlas deployment" }, workspaceId: WS, strategy: "analyze" });
    expect(result.candidates.map((row) => row.object_id)).toEqual([MEM.r]);
    expect(JSON.stringify(result)).not.toContain("hidden secret");
    expect(result.candidates[0]?.score_factors).toBeUndefined();
  });
});
