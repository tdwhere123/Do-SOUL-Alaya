import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import {
  attributeEvidenceSemanticWinners,
  buildEvidenceSemanticCandidates
} from
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
          documentIdentity: "owner",
          content: "grounded conversation evidence",
          projection: OWNER_PROJECTION
        }]
      }
    })).toEqual([{
      candidateKey: "workspace_local:memory_entry:memory-1",
      evidenceObjectId: "evidence-a",
      documentIdentity: "owner",
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
          content: "global evidence must not redefine local activation",
          projection: OWNER_PROJECTION
        }]
      }
    })).toEqual([{
      candidateKey: "workspace_local:evidence_capsule:evidence-1",
      evidenceObjectId: "evidence-1",
      documentIdentity: "assistant:1",
      content: direct.entry.content
    }]);
  });

  it("retains unresolved winners and attributes resolved owner documents", () => {
    const unresolved = {
      score: 0.8,
      evidenceObjectId: "evidence-missing",
      documentIdentity: "fact_key:9"
    };
    const owner = {
      score: 0.7,
      evidenceObjectId: "evidence-owner",
      documentIdentity: "owner"
    };

    expect([...attributeEvidenceSemanticWinners({
      winners: new Map([
        ["candidate:unresolved", unresolved],
        ["candidate:owner", owner]
      ]),
      evidenceDocumentsByMemoryId: {
        "memory-owner": [{
          evidenceRef: "evidence-owner",
          documentIdentity: "owner",
          content: "grounded owner evidence",
          projection: OWNER_PROJECTION
        }]
      }
    })]).toEqual([
      ["candidate:unresolved", { ...unresolved, projection: null }],
      ["candidate:owner", { ...owner, projection: OWNER_PROJECTION }]
    ]);
  });
});

const OWNER_PROJECTION = Object.freeze({
  projection_id: null,
  projection_kind: "owner" as const,
  matched_fact_key_forms: Object.freeze([])
});

function candidate(
  entry: Readonly<MemoryEntry>,
  overrides: Partial<CoarseRecallCandidate> = {}
): Readonly<CoarseRecallCandidate> {
  return Object.freeze({ entry, originPlane: "workspace_local", ...overrides });
}
