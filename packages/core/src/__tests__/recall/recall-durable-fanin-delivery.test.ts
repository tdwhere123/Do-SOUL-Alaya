import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { RecallService } from "../../recall/recall-service.js";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";
import { MEM, WS } from "./conditional-field/vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("source-only conditional delivery", () => {
  it("keeps actual memory output while source-less synthesis rank has no delivery authority", async () => {
    const f = await createSourceBoundRecallFixture((database) => databases.add(database));
    await f.writeMemory(MEM.r, "Atlas recall implementation memory", MemoryDimension.PROCEDURE);
    const searchByKeyword = vi.fn(async () => [{ object_id: "source-less-synthesis", normalized_rank: 1 }]);
    const findByIds = vi.fn(async () => []);
    const service = new RecallService({ ...f.dependencies, synthesisSearchPort: { searchByKeyword, findByIds } });
    const result = await service.recall({ taskSurface: { ...createTaskSurface(), display_name: "Atlas recall" }, workspaceId: WS, strategy: "analyze" });
    expect(result.candidates.map((row) => row.object_id)).toEqual([MEM.r]);
    expect(result.index?.entries.map((row) => row.object_id)).toEqual([MEM.r]);
    expect(result.synthesis.status).toBe("absent");
    expect(searchByKeyword).not.toHaveBeenCalled();
    expect(findByIds).not.toHaveBeenCalled();
  });
});
