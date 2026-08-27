import { describe, expect, it } from "vitest";
import {
  collectFieldSetEvidenceIds,
  directEvidenceCapsuleIds,
  fieldCandidateEvidenceIds
} from "../../../recall/runtime/field-candidate-evidence-ids.js";

describe("field candidate evidence ids", () => {
  it("keeps memory candidates on their evidence_refs only", () => {
    expect(fieldCandidateEvidenceIds({
      entry: { object_id: "mem-1", evidence_refs: ["ev-alice", "ev-alice"] }
    })).toEqual(["ev-alice"]);
  });

  it("unions a direct evidence-capsule object_id into the load set", () => {
    expect(fieldCandidateEvidenceIds({
      entry: { object_id: "ev-bob", evidence_refs: [] },
      objectKind: "evidence_capsule"
    })).toEqual(["ev-bob"]);
    expect(collectFieldSetEvidenceIds([
      { entry: { object_id: "mem-1", evidence_refs: ["ev-alice"] } },
      { entry: { object_id: "ev-bob", evidence_refs: [] }, objectKind: "evidence_capsule" }
    ])).toEqual(["ev-alice", "ev-bob"]);
  });

  it("keeps capture-only extras on direct evidence-capsule object ids", () => {
    expect(directEvidenceCapsuleIds([
      { entry: { object_id: "mem-1", evidence_refs: ["ev-alice"] } },
      { entry: { object_id: "ev-bob", evidence_refs: ["ev-alice"] }, objectKind: "evidence_capsule" },
      { entry: { object_id: "ev-bob", evidence_refs: [] }, objectKind: "evidence_capsule" }
    ])).toEqual(["ev-bob"]);
  });
});
