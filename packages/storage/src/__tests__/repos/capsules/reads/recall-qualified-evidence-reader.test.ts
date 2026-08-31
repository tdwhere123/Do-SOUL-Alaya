import { afterEach, describe, expect, it } from "vitest";
import { RecallQualifiedEvidenceReader } from "../../../../repos/capsules/reads/recall-qualified-evidence-reader.js";
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

describe("RecallQualifiedEvidenceReader parse failures", () => {
  it("counts skipped parse failures by default", async () => {
    const { database } = await createMalformedEvidenceRow();
    const reader = new RecallQualifiedEvidenceReader(database);

    expect(reader.find("workspace-1", [{ object_id: MALFORMED_OBJECT_ID }])).toEqual([]);
    expect(reader.skippedParseCount).toBe(1);
  });

  it("throws in strictParse instead of skipping the row", async () => {
    const { database } = await createMalformedEvidenceRow();
    const reader = new RecallQualifiedEvidenceReader(database, undefined, { strictParse: true });

    expect(() => reader.find("workspace-1", [{ object_id: MALFORMED_OBJECT_ID }])).toThrow(
      /Failed to validate evidence capsule row/
    );
    expect(reader.skippedParseCount).toBe(1);
  });
});

const MALFORMED_OBJECT_ID = "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9";

async function createMalformedEvidenceRow() {
  const created = await createEvidenceCapsuleRepo();
  await created.repo.create(createEvidenceCapsule({
    object_id: MALFORMED_OBJECT_ID,
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    evidence_health_state: "verified"
  }));
  created.database.connection
    .prepare("UPDATE evidence_capsules SET semantic_anchor = ? WHERE object_id = ?")
    .run("not-json", MALFORMED_OBJECT_ID);
  return created;
}
