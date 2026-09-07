import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import { createSourceBoundRecallFixture, createTaskSurface } from "../recall-service-test-fixtures.js";
import { MEM, WS } from "../conditional-field/vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("conditional source identity and evidence ownership", () => {
  it("delivers admitted memory while bare Assistant capsule search is outside the target route", async () => {
    const f = await createSourceBoundRecallFixture((database) => databases.add(database));
    await f.writeMemory(MEM.r, "TrailShell backpack source memory", MemoryDimension.FACT);
    const searchByKeyword = vi.fn(async () => [{ object_id: "assistant-capsule", normalized_rank: 1 }]);
    const findRecallQualifiedByIds = vi.fn(async () => { throw new Error("capsule projection is not a target source reader"); });
    const service = new RecallService({ ...f.dependencies, evidenceSearchPort: { searchByKeyword, findRecallQualifiedByIds } });
    const result = await service.recall({ taskSurface: { ...createTaskSurface(), display_name: "TrailShell backpack" }, workspaceId: WS, strategy: "build" });
    expect(result.candidates.map((row) => row.object_id)).toEqual([MEM.r]);
    expect(result.candidates[0]?.object_kind).toBe("memory_entry");
    expect(searchByKeyword).not.toHaveBeenCalled();
    expect(findRecallQualifiedByIds).not.toHaveBeenCalled();
  });
});
