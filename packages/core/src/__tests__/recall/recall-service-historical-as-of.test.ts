import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { RecallService } from "../../recall/recall-service.js";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";
import { createClaimForm } from "../governance/claim-service.test-support.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });
const AS_OF = "2023-05-30T23:40:00.000Z";

describe("historical source Recall with unavailable optional projections", () => {
  it("retains raw source observations without invoking the retired path expansion fallback", async () => {
    const f = await createSourceBoundRecallFixture((database) => databases.add(database));
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
    await f.writeSource({ objectId: id, content: "deployment checklist", createdAt: "2023-05-29T12:00:00.000Z" });
    const findByAnchors = vi.fn(async () => { throw new Error("retired path expansion invoked"); });
    await f.claimFormRepo.create(createClaimForm({ workspace_id: "workspace-1", claim_status: "active",
      source_object_refs: [id], created_at: "2023-05-29T12:00:00.000Z", updated_at: "2026-09-06T12:00:00.000Z" }));
    const result = await new RecallService({ ...f.dependencies,
      pathExpansionPort: { findByAnchors }
    }).recall({ taskSurface: createTaskSurface(), workspaceId: "workspace-1", strategy: "analyze",
      queryText: "deployment checklist", referenceTime: AS_OF });
    expect(result.candidates.map((entry) => entry.object_id)).toEqual([id]);
    expect(result.index.as_of).toBe(AS_OF);
    expect(result.active_constraints).toEqual([]);
    expect(result.active_constraints_count).toBeNull();
    expect(result.active_constraints_completeness).toBe("incomplete");
    expect(findByAnchors).not.toHaveBeenCalled();
    expect(result.index.completeness.interpretation_coverage).not.toBe("complete");
  });
});
