import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { buildRecallEvidencePack } from "../../recall/runtime/recall-evidence-pack.js";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";
import { MEM, WS } from "./conditional-field/vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("source-backed recall evidence pack", () => {
  it.each([["Atlas research", [MEM.r, MEM.l]], ["volcano", []]] as const)("records observed %s hits without model-quality claims", async (query, expected) => {
    const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
    await fixture.writeMemory(MEM.r, "Atlas research configuration", MemoryDimension.FACT);
    await fixture.writeMemory(MEM.l, "Atlas research logging", MemoryDimension.EPISODE);
    await fixture.writeMemory(MEM.u, "unrelated picnic menu", MemoryDimension.FACT);
    const result = await fixture.service.recall({ taskSurface: { ...createTaskSurface(), display_name: query }, workspaceId: WS, strategy: "analyze" });
    expect(result.candidates.map((row) => row.object_id).sort()).toEqual([...expected].sort());
    const pack = buildRecallEvidencePack({
      fixture_id: query, query, result, expected_object_ids: expected,
      delivery: { delivery_id: "delivery-1", delivered_object_ids: result.candidates.map((row) => row.object_id) },
      usage: { delivery_id: "delivery-1", used_object_ids: expected }
    });
    expect(pack.metrics).toMatchObject({ expected_hit_count: expected.length, coverage: 1, factual_expected_hit: true });
    expect(pack.delivery_link?.delivery_id).toBe(pack.usage_link?.delivery_id);
    expect(pack.metrics.token_footprint > 0).toBe(expected.length > 0);
    if (expected.length === 0) expect(result.index?.completeness.logical_index).toBe("open");
  });
});
