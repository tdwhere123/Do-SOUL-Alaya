import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import {
  attributeEvidenceSemanticActivations,
  buildEvidenceSemanticCandidateSelection
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

    expect(buildEvidenceSemanticCandidateSelection({
      candidates: [memory],
      evidenceDocumentsByMemoryId: {
        "memory-1": [{
          evidenceRef: "evidence-a",
          documentIdentity: "owner",
          content: "grounded conversation evidence",
          projection: OWNER_PROJECTION
        }]
      }
    }).candidates).toEqual([{
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

    expect(buildEvidenceSemanticCandidateSelection({
      candidates: [direct, local, global],
      evidenceDocumentsByMemoryId: {
        "memory-2": [{
          evidenceRef: "evidence-2",
          documentIdentity: "evidence-2",
          content: "global evidence must not redefine local activation",
          projection: OWNER_PROJECTION
        }]
      }
    }).candidates).toEqual([{
      candidateKey: "workspace_local:evidence_capsule:evidence-1",
      evidenceObjectId: "evidence-1",
      documentIdentity: "assistant:1",
      content: direct.entry.content
    }]);
  });

  it("excludes only owner gist documents when a single semantic leader is disabled", () => {
    const memory = candidate(createMemoryEntry({ object_id: "memory-1" }));
    const direct = candidate(createMemoryEntry({ object_id: "evidence-1" }), {
      objectKind: "evidence_capsule"
    });
    const documents = {
      "memory-1": [{
        evidenceRef: "evidence-owner",
        documentIdentity: "owner_gist_600",
        content: "complete source gist",
        projection: OWNER_PROJECTION
      }, {
        evidenceRef: "evidence-fact",
        documentIdentity: "fact_key:1",
        content: "qualified fact key",
        projection: {
          ...OWNER_PROJECTION,
          projection_kind: "fact_key" as const
        }
      }]
    };

    expect(buildEvidenceSemanticCandidateSelection({
      candidates: [memory, direct],
      evidenceDocumentsByMemoryId: documents,
      includeOwnerGist: false
    }).candidates.map((candidate) => candidate.documentIdentity)).toEqual([
      "fact_key:1",
      "owner"
    ]);
  });

  it("uses candidate order for gist budget and retains document identities", () => {
    const leaders = Array.from({ length: 16 }, (_, index) => candidate(
      createMemoryEntry({ object_id: `memory-leader-${index}` })
    ));
    const leader = leaders[0]!;
    const follower = candidate(createMemoryEntry({ object_id: "memory-follower" }));
    const shared = "same grounded source gist";

    const selection = buildEvidenceSemanticCandidateSelection({
      candidates: [...leaders, follower],
      evidenceDocumentsByMemoryId: {
        "memory-leader-0": [{
          evidenceRef: "evidence-leader",
          documentIdentity: "owner_gist_600",
          content: shared,
          projection: OWNER_PROJECTION
        }, {
          evidenceRef: "evidence-leader",
          documentIdentity: "owner",
          content: shared,
          projection: OWNER_PROJECTION
        }],
        "memory-follower": [{
          evidenceRef: "evidence-follower",
          documentIdentity: "owner_gist_600",
          content: "other gist",
          projection: OWNER_PROJECTION
        }, {
          evidenceRef: "evidence-follower",
          documentIdentity: "owner",
          content: "other owner excerpt",
          projection: OWNER_PROJECTION
        }]
      },
      includeOwnerGist: true
    });

    expect(selection.candidates.map((row) =>
      `${row.candidateKey}:${row.documentIdentity}`
    )).toEqual([
      "workspace_local:memory_entry:memory-leader-0:owner_gist_600",
      "workspace_local:memory_entry:memory-leader-0:owner",
      "workspace_local:memory_entry:memory-follower:owner"
    ]);
    expect(selection.receipt).toMatchObject({
      operator_id: "ordered_candidate_prefix_v1",
      input_candidate_keys: [
        "workspace_local:memory_entry:memory-leader-0",
        "workspace_local:memory_entry:memory-leader-1",
        "workspace_local:memory_entry:memory-leader-2",
        "workspace_local:memory_entry:memory-leader-3",
        "workspace_local:memory_entry:memory-leader-4",
        "workspace_local:memory_entry:memory-leader-5",
        "workspace_local:memory_entry:memory-leader-6",
        "workspace_local:memory_entry:memory-leader-7",
        "workspace_local:memory_entry:memory-leader-8",
        "workspace_local:memory_entry:memory-leader-9",
        "workspace_local:memory_entry:memory-leader-10",
        "workspace_local:memory_entry:memory-leader-11",
        "workspace_local:memory_entry:memory-leader-12",
        "workspace_local:memory_entry:memory-leader-13",
        "workspace_local:memory_entry:memory-leader-14",
        "workspace_local:memory_entry:memory-leader-15",
        "workspace_local:memory_entry:memory-follower"
      ],
      owner_gist_candidate_keys: [
        "workspace_local:memory_entry:memory-leader-0",
        "workspace_local:memory_entry:memory-leader-1",
        "workspace_local:memory_entry:memory-leader-2",
        "workspace_local:memory_entry:memory-leader-3",
        "workspace_local:memory_entry:memory-leader-4",
        "workspace_local:memory_entry:memory-leader-5",
        "workspace_local:memory_entry:memory-leader-6",
        "workspace_local:memory_entry:memory-leader-7",
        "workspace_local:memory_entry:memory-leader-8",
        "workspace_local:memory_entry:memory-leader-9",
        "workspace_local:memory_entry:memory-leader-10",
        "workspace_local:memory_entry:memory-leader-11",
        "workspace_local:memory_entry:memory-leader-12",
        "workspace_local:memory_entry:memory-leader-13",
        "workspace_local:memory_entry:memory-leader-14",
        "workspace_local:memory_entry:memory-leader-15"
      ],
      owner_gist_limit: 16,
      owner_gist_selected_count: 16,
      owner_gist_excluded_count: 1
    });
  });

  it("scores leave-one-out fact keys only for selected full-evidence memories", () => {
    const leaders = Array.from({ length: 32 }, (_, index) => candidate(
      createMemoryEntry({ object_id: `memory-leader-${index}` })
    ));
    const leader = leaders[0]!;
    const follower = candidate(createMemoryEntry({ object_id: "memory-follower" }));
    const leaveOneOut = {
      projection_id: 2,
      projection_kind: "fact_key" as const,
      matched_fact_key_forms: Object.freeze([{
        kind: "leave_one_slot_out" as const,
        omitted_slot: Object.freeze({ slot_index: 0, role: "subject" as const })
      }])
    };
    const complete = {
      projection_id: 1,
      projection_kind: "fact_key" as const,
      matched_fact_key_forms: Object.freeze([{ kind: "complete" as const }])
    };

    const selection = buildEvidenceSemanticCandidateSelection({
      candidates: [...leaders, follower],
      evidenceDocumentsByMemoryId: {
        "memory-leader-0": [{
          evidenceRef: "evidence-leader",
          documentIdentity: "fact_key:1",
          content: "complete leader fact",
          projection: complete
        }, {
          evidenceRef: "evidence-leader",
          documentIdentity: "fact_key:2",
          content: "leave-one-out leader fact",
          projection: leaveOneOut
        }],
        "memory-follower": [{
          evidenceRef: "evidence-follower",
          documentIdentity: "fact_key:1",
          content: "complete follower fact",
          projection: complete
        }, {
          evidenceRef: "evidence-follower",
          documentIdentity: "fact_key:2",
          content: "leave-one-out follower fact",
          projection: leaveOneOut
        }]
      }
    });

    expect(selection.candidates.map((row) =>
      `${row.candidateKey}:${row.documentIdentity}`
    )).toEqual([
      "workspace_local:memory_entry:memory-leader-0:fact_key:1",
      "workspace_local:memory_entry:memory-leader-0:fact_key:2",
      "workspace_local:memory_entry:memory-follower:fact_key:1"
    ]);
    expect(selection.receipt).toMatchObject({
      full_evidence_candidate_keys: [
        "workspace_local:memory_entry:memory-leader-0",
        "workspace_local:memory_entry:memory-leader-1",
        "workspace_local:memory_entry:memory-leader-2",
        "workspace_local:memory_entry:memory-leader-3",
        "workspace_local:memory_entry:memory-leader-4",
        "workspace_local:memory_entry:memory-leader-5",
        "workspace_local:memory_entry:memory-leader-6",
        "workspace_local:memory_entry:memory-leader-7",
        "workspace_local:memory_entry:memory-leader-8",
        "workspace_local:memory_entry:memory-leader-9",
        "workspace_local:memory_entry:memory-leader-10",
        "workspace_local:memory_entry:memory-leader-11",
        "workspace_local:memory_entry:memory-leader-12",
        "workspace_local:memory_entry:memory-leader-13",
        "workspace_local:memory_entry:memory-leader-14",
        "workspace_local:memory_entry:memory-leader-15",
        "workspace_local:memory_entry:memory-leader-16",
        "workspace_local:memory_entry:memory-leader-17",
        "workspace_local:memory_entry:memory-leader-18",
        "workspace_local:memory_entry:memory-leader-19",
        "workspace_local:memory_entry:memory-leader-20",
        "workspace_local:memory_entry:memory-leader-21",
        "workspace_local:memory_entry:memory-leader-22",
        "workspace_local:memory_entry:memory-leader-23",
        "workspace_local:memory_entry:memory-leader-24",
        "workspace_local:memory_entry:memory-leader-25",
        "workspace_local:memory_entry:memory-leader-26",
        "workspace_local:memory_entry:memory-leader-27",
        "workspace_local:memory_entry:memory-leader-28",
        "workspace_local:memory_entry:memory-leader-29",
        "workspace_local:memory_entry:memory-leader-30",
        "workspace_local:memory_entry:memory-leader-31"
      ],
      full_evidence_limit: 32,
      full_evidence_selected_count: 32,
      full_evidence_excluded_count: 1
    });
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
