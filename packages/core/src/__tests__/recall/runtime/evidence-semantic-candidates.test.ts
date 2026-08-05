import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import {
  attributeEvidenceSemanticActivations,
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

  it("attributes every scored document and retains the same deterministic winner", () => {
    const factKey = {
      projection_id: 5,
      projection_kind: "fact_key" as const,
      matched_fact_key_forms: Object.freeze([{
        kind: "leave_one_slot_out" as const,
        omitted_slot: Object.freeze({ slot_index: 2, role: "value" as const })
      }])
    };
    const winner = Object.freeze({
      score: 0.8,
      evidenceObjectId: "evidence-fact",
      documentIdentity: "fact_key:5"
    });
    const owner = Object.freeze({
      score: 0.7,
      evidenceObjectId: "evidence-owner",
      documentIdentity: "owner"
    });
    const activation = Object.freeze({
      schema_version: 1 as const,
      operator_id: "evidence_document_max_v1" as const,
      state: "observed" as const,
      score: winner.score,
      winner,
      observations: Object.freeze([winner, owner]),
      observation_completeness: "complete" as const,
      missing_channel_policy: "no_op" as const
    });

    expect([...attributeEvidenceSemanticActivations({
      activations: new Map([["candidate:memory", activation]]),
      evidenceDocumentsByMemoryId: {
        "memory-fact": [{
          evidenceRef: "evidence-fact",
          documentIdentity: "fact_key:5",
          content: "grounded fact projection",
          projection: factKey
        }],
        "memory-owner": [{
          evidenceRef: "evidence-owner",
          documentIdentity: "owner",
          content: "grounded owner evidence",
          projection: OWNER_PROJECTION
        }]
      }
    })]).toEqual([["candidate:memory", {
      ...activation,
      winner: { ...winner, projection: factKey },
      observations: [
        { ...winner, projection: factKey },
        { ...owner, projection: OWNER_PROJECTION }
      ]
    }]]);
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
