import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";
import { createClaimForm } from "../governance/claim-service.test-support.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("RecallService constraints remain independent of index pagination", () => {
  it("keeps every active constraint outside a three-entry source page", async () => {
    const f = await createSourceBoundRecallFixture((database) => databases.add(database));
    const ids: string[] = [];
    for (let offset = 1; offset <= 6; offset += 1) {
      const objectId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(offset).padStart(12, "0")}`;
      await f.writeMemory(objectId, "deployment checklist", "constraint");
      await f.claimFormRepo.create(createClaimForm({
        object_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(offset).padStart(12, "0")}`,
        workspace_id: "workspace-1", claim_status: "active", source_object_refs: [objectId]
      }));
      ids.push(objectId);
    }
    const result = await f.service.recall({ taskSurface: createTaskSurface(),
      workspaceId: "workspace-1", strategy: "analyze", queryText: "deployment checklist", pageBudget: 3 });
    expect(result.candidates).toHaveLength(3);
    expect(result.active_constraints.map((entry) => entry.object_id)).toEqual(ids);
    expect(result.active_constraints_count).toBe(6);
  });
});
