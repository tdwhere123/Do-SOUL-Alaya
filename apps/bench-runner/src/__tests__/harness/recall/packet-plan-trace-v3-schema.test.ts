import { describe, expect, it } from "vitest";
import { RecallPacketPlanTraceSchema } from
  "../../../harness/recall/recall-diagnostics-support-schema.js";

const BASELINE = Object.freeze([
  "workspace_local:memory_entry:source-a",
  "workspace_local:memory_entry:displaced-b",
  "workspace_local:memory_entry:baseline-c",
  "workspace_local:memory_entry:baseline-d",
  "workspace_local:memory_entry:baseline-e",
  "workspace_local:synthesis_capsule:evicted-f"
]);
const SATISFIED = "workspace_local:memory_entry:satisfied-x";

const graphAuthorization = Object.freeze({
  kind: "graph_path_opportunity",
  authorized_candidate_key: SATISFIED,
  satisfied_by_candidate_key: SATISFIED,
  satisfied_head_slot: 2,
  displaced_head_baseline: { slot: 2, candidate_key: BASELINE[1] },
  evicted_packet_baseline: { slot: 6, candidate_key: BASELINE[5] },
  witness: Object.freeze({
    source_candidate_key: BASELINE[0],
    target_candidate_key: SATISFIED,
    path_id: "answers-with-path",
    path_source_version: "relation-version-1",
    relation_kind: "answers_with",
    graph_expansion_rank: 1,
    source_proximity_rank: 1
  })
});

describe("packet-plan trace v3 schema", () => {
  it("accepts all typed membership authorization witnesses", () => {
    const authorizations = [
      {
        ...graphAuthorization,
        kind: "direct_query_evidence",
        witness: {
          origin: "planned_tail_opportunity",
          stream: "lexical_fts",
          rank: 1,
          source_proximity_rank: 1,
          source_evidence_agreement_rank: 1
        }
      },
      graphAuthorization,
      {
        ...graphAuthorization,
        kind: "behavior_identity",
        witness: { evidence_ref: "evidence:verified-user-assertion" }
      },
      {
        ...graphAuthorization,
        kind: "same_session_substitution",
        authorized_candidate_key: BASELINE[1],
        witness: {
          protected_candidate_key: BASELINE[1],
          substitute_candidate_key: SATISFIED,
          session_key: "session-1",
          source_candidate_key: BASELINE[1],
          target_candidate_key: SATISFIED,
          path_id: "answers-with-path",
          path_source_version: "relation-version-1",
          relation_kind: "answers_with"
        }
      }
    ] as const;

    for (const authorization of authorizations) {
      const parsed = RecallPacketPlanTraceSchema.parse(
        packetTrace([authorization])
      );
      expect(parsed.membership_authorizations).toEqual([authorization]);
    }
  });

  it("requires membership_authorizations in schema v3", () => {
    const { membership_authorizations: _omitted, ...withoutReceipts } = packetTrace([]);

    expect(() => RecallPacketPlanTraceSchema.parse(withoutReceipts)).toThrow();
  });

  it.each([
    ["satisfied slot", { satisfied_head_slot: 1 }],
    ["authorized candidate", { authorized_candidate_key: BASELINE[2] }],
    ["satisfied candidate", { satisfied_by_candidate_key: BASELINE[2] }],
    ["displaced slot", {
      displaced_head_baseline: { slot: 1, candidate_key: BASELINE[1] }
    }],
    ["displaced candidate", {
      displaced_head_baseline: { slot: 2, candidate_key: BASELINE[2] }
    }],
    ["evicted packet slot", {
      evicted_packet_baseline: { slot: 5, candidate_key: BASELINE[5] }
    }]
  ])("rejects a tampered %s binding", (_name, patch) => {
    expect(() => RecallPacketPlanTraceSchema.parse(packetTrace([{
      ...graphAuthorization,
      ...patch
    }]))).toThrow();
  });

  it.each([
    ["target", { target_candidate_key: BASELINE[2] }],
    ["path", { path_id: "" }],
    ["version", { path_source_version: " " }],
    ["relation", { relation_kind: "supports" }]
  ])("rejects a graph witness with a tampered %s", (_name, witnessPatch) => {
    expect(() => RecallPacketPlanTraceSchema.parse(packetTrace([{
      ...graphAuthorization,
      witness: { ...graphAuthorization.witness, ...witnessPatch }
    }]))).toThrow();
  });

  it("accepts an embedding-owned permutation of the baseline head", () => {
    const consensusHead = [BASELINE[1], BASELINE[0], BASELINE[2]];
    const planned = [...consensusHead, ...BASELINE.slice(3)];
    expect(() => RecallPacketPlanTraceSchema.parse({
      schema_version: 3,
      assessment_path: "snapshot",
      baseline_candidate_keys: BASELINE,
      planned_candidate_keys: planned,
      actual_candidate_keys: planned,
      head_width: 3,
      baseline_head_candidate_keys: BASELINE.slice(0, 3),
      embedding_head: consensusHead.map((candidateKey, index) => ({
        candidate_key: candidateKey,
        embedding_rank: index + 1
      })),
      consensus_head_candidate_keys: consensusHead,
      immutable_tail_candidate_keys: BASELINE.slice(3),
      membership_authorizations: [],
      protected_candidates: [],
      added_candidate_keys: [],
      removed_candidate_keys: [],
      decision: { status: "accepted", reason: "strict_tail_consensus" }
    })).not.toThrow();
  });

  it("rejects a new head member disguised as a protected baseline candidate", () => {
    expect(() => RecallPacketPlanTraceSchema.parse({
      ...packetTrace([]),
      protected_candidates: [{ candidate_key: SATISFIED, rank_limit: 2 }]
    })).toThrow();
  });

  it.each([
    ["embedding stream", { stream: "embedding_similarity" }],
    ["out-of-head direct rank", { rank: 6 }],
    ["blank evidence ref", { evidence_ref: " " }]
  ])("rejects an invalid direct or behavior %s", (name, witnessPatch) => {
    const kind = name === "blank evidence ref"
      ? "behavior_identity" as const
      : "direct_query_evidence" as const;
    const witness = kind === "behavior_identity"
      ? witnessPatch
      : {
          origin: "planned_tail_opportunity",
          stream: "lexical_fts",
          rank: 1,
          source_proximity_rank: 1,
          source_evidence_agreement_rank: 1,
          ...witnessPatch
        };
    expect(() => RecallPacketPlanTraceSchema.parse(packetTrace([{
      ...graphAuthorization,
      kind,
      witness
    }]))).toThrow();
  });

  it("rejects a graph expansion rank outside the governed head", () => {
    expect(() => RecallPacketPlanTraceSchema.parse(packetTrace([{
      ...graphAuthorization,
      witness: { ...graphAuthorization.witness, graph_expansion_rank: 6 }
    }]))).toThrow();
  });
});

function packetTrace(membershipAuthorizations: readonly unknown[]) {
  const planned = [
    BASELINE[0], SATISFIED, BASELINE[2], BASELINE[3], BASELINE[4], BASELINE[1]
  ];
  return {
    schema_version: 3,
    assessment_path: "snapshot",
    baseline_candidate_keys: BASELINE,
    planned_candidate_keys: planned,
    actual_candidate_keys: planned,
    head_width: 5,
    baseline_head_candidate_keys: BASELINE.slice(0, 5),
    embedding_head: [],
    consensus_head_candidate_keys: planned.slice(0, 5),
    immutable_tail_candidate_keys: planned.slice(5),
    tail_policy: "nested_membership_exchange",
    membership_authorizations: membershipAuthorizations,
    protected_candidates: [],
    added_candidate_keys: [SATISFIED],
    removed_candidate_keys: [BASELINE[5]],
    decision: { status: "accepted", reason: "nested_membership_consensus" }
  };
}
