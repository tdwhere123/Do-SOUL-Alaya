import { afterEach, describe, expect, it } from "vitest";
import type { ConditionalFieldRecallPortResult } from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createSourceBoundRecallFixture, createTaskSurface } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { conditionalRecallPayload, createQueryOnlyRuntime, dispatchQueryOnly } from "./query-only-hydration-fixture.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("admitted relation to worker Recall", () => {
  it("reaches a lexically absent source through an admitted typed relation with provenance", async () => {
    const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
    const seed = "aaaaaaaa-1111-4111-8111-111111111111";
    const linked = "bbbbbbbb-2222-4222-8222-222222222222";
    await fixture.writeSource({ objectId: seed, content: "yesterday failed deployment of checkout", dimension: "episode" });
    await fixture.writeSource({ objectId: linked, content: "isolated routing configuration", dimension: "fact" });
    fixture.database.connection.prepare("UPDATE memory_entries SET event_time_start = ? WHERE object_id = ?")
      .run("2026-09-05T12:00:00.000Z", seed);
    const lexical = fixture.memoryReader.lexical("workspace-1", "failed deployment", 16);
    expect(lexical.ids).toContain(seed);
    expect(lexical.ids).not.toContain(linked);
    await fixture.admitRelation({ evidenceId: "cccccccc-3333-4333-8333-333333333333",
      assertionId: "worker-path-source", sourceId: seed, targetId: linked, resultObjectId: linked,
      relationKind: "config_direct", validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
      gist: "config_direct" });
    const native = fixture.relationReader.read("workspace-1", seed, "config_direct", 16, 512, null,
      "2026-09-06T12:00:00.000Z");
    expect(native.observations, JSON.stringify(native)).toHaveLength(1);
    const local = await fixture.service.recall({ workspaceId: "workspace-1", strategy: "analyze",
      taskSurface: { ...createTaskSurface(), display_name: "yesterday failed deployment" },
      queryText: "yesterday failed deployment", pageBudget: 100 });
    expect(local.index.entries.map((row) => row.object_id), JSON.stringify(local.index)).toContain(linked);
    const result = await dispatchQueryOnly(createQueryOnlyRuntime(fixture.database), "conditionalField.recall", {
      ...conditionalRecallPayload("yesterday failed deployment"),
      interpretation_clock: "2026-09-06T12:00:00.000Z", as_of: "2026-09-06T12:00:00.000Z",
      lifetime_now: "2026-09-06T12:00:00.000Z"
    }) as ConditionalFieldRecallPortResult;
    const entry = result.index.entries.find((row) => row.object_id === linked);
    expect(entry, JSON.stringify(result.index)).toBeDefined();
    expect(entry?.association_milligrades).toBe(1000);
    expect(entry?.claim).toBe("supported");
    expect(result.index.explanations?.some((row) => row.leaf_ids.includes("worker-path-source"))).toBe(true);
    expect(result.previews[linked]).toContain("isolated routing");
  });
});
