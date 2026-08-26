import { afterEach, describe, expect, it } from "vitest";
import { MemoryGovernanceEventType } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases as databases
} from "./evidence-capsule-repo-fixture.js";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("SqliteEvidenceCapsuleRepo.createInCurrentTransaction", () => {
  it("joins the caller transaction so a later throw rolls back EventLog and capsule", async () => {
    const { repo, database } = await createEvidenceCapsuleRepo();
    const eventLogRepo = new SqliteEventLogRepo(database);
    const capsule = createEvidenceCapsule();

    expect(() =>
      eventLogRepo.transactional(() => {
        eventLogRepo.append({
          event_type: MemoryGovernanceEventType.SOUL_EVIDENCE_CREATED,
          entity_type: "evidence_capsule",
          entity_id: capsule.object_id,
          workspace_id: capsule.workspace_id,
          run_id: capsule.run_id,
          caused_by: capsule.created_by,
          payload_json: {
            object_id: capsule.object_id,
            object_kind: capsule.object_kind,
            workspace_id: capsule.workspace_id,
            run_id: capsule.run_id
          }
        });
        repo.createInCurrentTransaction(capsule);
        throw new Error("row failed after append");
      })
    ).toThrow("row failed after append");

    await expect(repo.findById(capsule.object_id)).resolves.toBeNull();
    await expect(eventLogRepo.queryByEntity("evidence_capsule", capsule.object_id)).resolves.toEqual([]);
  });
});
