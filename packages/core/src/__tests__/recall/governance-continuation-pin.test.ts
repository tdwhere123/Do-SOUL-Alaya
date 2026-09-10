import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { capableRecallConsumerDeclaration, RecallService } from "../../recall/recall-service.js";
import { createDependencies, createTaskSurface } from "./recall-service-test-fixtures.js";
import { readersFor } from "./conditional-field-oracle/bound-producer.js";
import { openSourceSlice, NOW } from "./conditional-field/vertical/source-slice.js";

const databases: StorageDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("governance mutation invalidates conditional Recall continuations", () => {
  it.each(["claim", "path", "selection", "generation"])("rejects a stale page after same-time %s mutation", async (kind) => {
    const fixture = await openSourceSlice((database) => databases.push(database));
    const service = new RecallService({ ...createDependencies().dependencies, now: () => NOW,
      observerReaders: readersFor(fixture) });
    for (let index = 0; index < 3; index += 1) {
      await fixture.writeMemory(`aaaaaaaa-aaaa-4aaa-8aaa-00000000030${index}`, "deployment source", MemoryDimension.FACT);
    }
    const request = { ...capableRecallConsumerDeclaration(), workspaceId: "workspace-1", strategy: "chat" as const,
      taskSurface: { ...createTaskSurface(), display_name: "deployment" }, queryText: "deployment", pageBudget: 1 };
    const first = await service.recall(request);
    expect(first.index.continuation).not.toBeNull();
    const sql = kind === "claim" ? `INSERT INTO claim_forms(object_id,created_at,updated_at,created_by,
      governance_subject,claim_kind,scope_class,enforcement_level,origin_tier,precedence_basis,proposition_digest,workspace_id)
      VALUES ('claim','2026-09-06T12:00:00.000Z','2026-09-06T12:00:00.000Z','user_action','{}','constraint',
      'project','hard','user','explicit','digest','workspace-1')`
      : kind === "path" ? `INSERT INTO path_relations(path_id,workspace_id,anchors_json,constitution_json,effect_vector_json,
        plasticity_state_json,lifecycle_json,legitimacy_json,created_at,updated_at)
        VALUES ('path','workspace-1','{}','{}','{}','{}','{}','{}','2026-09-06T12:00:00.000Z','2026-09-06T12:00:00.000Z')`
        : kind === "selection" ? "UPDATE temporal_schema_state SET projection_refresh_required=1 WHERE state_id=1"
          : `UPDATE temporal_projection_generations SET status='retired'
            WHERE generation=(SELECT active_projection_generation FROM temporal_schema_state WHERE state_id=1)`;
    fixture.database.connection.exec(sql);
    const resumed = await service.recall({ ...request, continuation: first.index.continuation });
    expect(resumed.index.completeness.logical_index).toBe("invalidated");
    expect(resumed.index.entries).toEqual([]);
  });
});
