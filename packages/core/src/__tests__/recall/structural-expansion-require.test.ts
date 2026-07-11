import { describe, expect, it, vi } from "vitest";
import { CoreError } from "../../shared/errors.js";
import { collectEntityDerivedSeeds } from "../../recall/expansion/structural-expansion.js";
import type { MemoryEntry } from "@do-soul/alaya-protocol";

function createMemoryEntry(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    content: `content for ${objectId}`,
    content_hash: `${objectId}-hash`,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    workspace_id: "workspace-1",
    kind: "note",
    version: 1
  } as MemoryEntry;
}

describe("structural-expansion require helpers", () => {
  it("throws CONFLICT when searchByKeyword is missing", async () => {
    const entry = createMemoryEntry("memory-1");
    await expect(
      collectEntityDerivedSeeds({
        workspaceId: "workspace-1",
        queryText: "alpha beta",
        byId: new Map([[entry.object_id, entry]]),
        addCandidate: () => true,
        lexicalFtsRanks: new Map(),
        entityExtractionPort: {
          extract: vi.fn(async () => [{ surface: "alpha", normalized: "alpha", confidence: 1 }])
        },
        memoryRepo: {},
        warn: vi.fn(),
        entityExtractionMaxEntities: 5,
        entitySeedPerEntityTopKStrong: 3,
        entitySeedPerEntityTopKWeak: 2,
        entitySeedTotalAdmitCap: 10,
        entitySeedMinSurfaceLength: 2
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message: "Memory repo searchByKeyword is required for entity seed lookup"
    } satisfies Partial<CoreError>);
  });
});
