import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import { buildEvidenceSemanticCandidates } from
  "../../../recall/runtime/orchestration/evidence-semantic-candidates.js";
import type { CoarseRecallCandidate } from
  "../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

describe("evidence semantic candidate projection", () => {
  it("attributes linked evidence activation to its memory object", () => {
    const memory = candidate(createMemoryEntry({
      object_id: "memory-1",
      evidence_refs: ["evidence-b", "evidence-a"]
    }));

    expect(buildEvidenceSemanticCandidates({
      candidates: [memory],
      evidenceDocumentsByMemoryId: {
        "memory-1": [{
          evidenceRef: "evidence-a",
          documentIdentity: "evidence-a",
          content: "grounded conversation evidence"
        }]
      }
    })).toEqual([{
      candidateKey: "workspace_local:memory_entry:memory-1",
      objectId: "memory-1",
      documentIdentity: "linked_evidence:evidence-a",
      content: "grounded conversation evidence"
    }]);
  });

  it("keeps direct evidence and ignores unobserved or non-local projections", () => {
    const direct = candidate(createMemoryEntry({ object_id: "evidence-1" }), {
      objectKind: "evidence_capsule",
      evidenceDocumentIdentity: "assistant:1"
    });
    const local = candidate(createMemoryEntry({ object_id: "memory-1" }));
    const global = candidate(createMemoryEntry({ object_id: "memory-2" }), {
      originPlane: "global"
    });

    expect(buildEvidenceSemanticCandidates({
      candidates: [direct, local, global],
      evidenceDocumentsByMemoryId: {
        "memory-2": [{
          evidenceRef: "evidence-2",
          documentIdentity: "evidence-2",
          content: "global evidence must not redefine local activation"
        }]
      }
    })).toEqual([{
      candidateKey: "workspace_local:evidence_capsule:evidence-1",
      objectId: "evidence-1",
      documentIdentity: "assistant:1",
      content: direct.entry.content
    }]);
  });
});

function candidate(
  entry: Readonly<MemoryEntry>,
  overrides: Partial<CoarseRecallCandidate> = {}
): Readonly<CoarseRecallCandidate> {
  return Object.freeze({ entry, originPlane: "workspace_local", ...overrides });
}
