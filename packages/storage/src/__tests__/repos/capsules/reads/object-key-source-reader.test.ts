import { afterEach, describe, expect, it } from "vitest";
import { readObjectKeyEvidenceSources } from "../../../../repos/capsules/reads/object-key-source-reader.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases as databases
} from "../evidence-capsule-repo-fixture.js";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("readObjectKeyEvidenceSources", () => {
  it("reads gist independently of unqualified derived projections", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = createEvidenceCapsule({
      object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      gist: "She loves her Golden Retriever."
    });
    await repo.create(capsule);
    database.connection.prepare(`
      INSERT INTO evidence_search_projections (
        evidence_object_id, projection_id, projection_kind,
        workspace_id, source_hash, content
      ) VALUES (?, 1, 'fact_key', ?, 'hash-1', ?)
    `).run(capsule.object_id, capsule.workspace_id, "I took my niece to the museum");

    expect(readObjectKeyEvidenceSources(
      database,
      capsule.workspace_id,
      [capsule.object_id, "missing-evidence"]
    )).toEqual([{
      object_id: capsule.object_id,
      gist: "She loves her Golden Retriever.",
    }]);
  });

});
