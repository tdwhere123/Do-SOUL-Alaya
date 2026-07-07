import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, type MemoryEntry } from "@do-soul/alaya-protocol";
import { MemoryQueryService } from "../../memory/memory-service/memory-query-service.js";
import type { MemoryEntryReadPort } from "../../memory/memory-service/types.js";
import { createMemoryEntry } from "./memory-service-test-fixtures.js";
import { requireAt } from "../helpers/defined.js";

describe("MemoryQueryService", () => {
  it("hides cross-workspace rows on scoped single and batch lookups", async () => {
    const local = createMemoryEntry({ object_id: "memory-local", workspace_id: "workspace-1" });
    const foreign = createMemoryEntry({ object_id: "memory-foreign", workspace_id: "workspace-2" });
    const repo = createReadRepo({
      findById: vi.fn(async (objectId) => objectId === local.object_id ? local : foreign)
    });
    const service = new MemoryQueryService({ memoryEntryRepo: repo });

    await expect(service.findByIdScoped(local.object_id, "workspace-1")).resolves.toEqual(local);
    await expect(service.findByIdScoped(foreign.object_id, "workspace-1")).resolves.toBeNull();
    await expect(service.findByIdsScoped([local.object_id, foreign.object_id], "workspace-1")).resolves.toEqual([
      local
    ]);
  });

  it("uses repo batch lookup when available and still filters workspace ownership", async () => {
    const local = createMemoryEntry({ object_id: "memory-local", workspace_id: "workspace-1" });
    const foreign = createMemoryEntry({ object_id: "memory-foreign", workspace_id: "workspace-2" });
    const findByIds = vi.fn(async () => [local, foreign]);
    const repo = createReadRepo({ findByIds });
    const service = new MemoryQueryService({ memoryEntryRepo: repo });

    await expect(service.findByIdsScoped([local.object_id, foreign.object_id], "workspace-1")).resolves.toEqual([
      local
    ]);
    expect(findByIds).toHaveBeenCalledWith("workspace-1", [local.object_id, foreign.object_id]);
  });

  it("falls back to paginated scans for all/count helpers", async () => {
    const rows = [
      createMemoryEntry({ object_id: "memory-a" }),
      createMemoryEntry({ object_id: "memory-b" })
    ];
    const findByRunId = vi.fn(async () => rows);
    const repo = createReadRepo({ findByRunId });
    const service = new MemoryQueryService({ memoryEntryRepo: repo });

    await expect(service.findByRunIdAll("run-1")).resolves.toEqual(rows);
    await expect(service.countByRunId("run-1")).resolves.toBe(2);
    expect(findByRunId.mock.calls.map((call) => requireAt(call, 1))).toEqual([
      { limit: 500, offset: 0 },
      { limit: 500, offset: 0 }
    ]);
  });

  it("throws clearly when optional conflict query ports are absent", async () => {
    const service = new MemoryQueryService({ memoryEntryRepo: createReadRepo() });

    await expect(service.countByWorkspaceIdWithConflict("workspace-1")).rejects.toThrow(
      "countByWorkspaceIdWithConflict is not supported by memory entry repo"
    );
    expect(() =>
      service.findByScopeClassAndDimensionWithConflict("workspace-1", ScopeClass.PROJECT, MemoryDimension.FACT)
    ).toThrow("findByScopeClassAndDimensionWithConflict is not supported by memory entry repo");
  });
});

function createReadRepo(overrides: Partial<MemoryEntryReadPort> = {}): MemoryEntryReadPort {
  const rows: readonly Readonly<MemoryEntry>[] = [];
  return {
    findById: vi.fn(async () => null),
    findByWorkspaceId: vi.fn(async () => rows),
    findByRunId: vi.fn(async () => rows),
    findByDimension: vi.fn(async () => rows),
    findByScopeClass: vi.fn(async () => rows),
    ...overrides
  };
}
