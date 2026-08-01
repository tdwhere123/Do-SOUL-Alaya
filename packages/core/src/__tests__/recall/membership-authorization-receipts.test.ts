import { describe, expect, it } from "vitest";
import {
  assertRecallPacketPlanObservation,
  type RecallPacketPlanObservation
} from "../../recall/delivery/packet-plan/packet-plan-observation.js";
import { captureSupportSetPacketPlanTrace } from
  "../../recall/delivery/packet-plan/packet-plan-trace.js";

type MembershipAuthorization = Readonly<{
  readonly kind: "direct_query_evidence" | "graph_path_opportunity" |
    "behavior_identity" | "selector_consensus" | "same_session_substitution";
  readonly authorized_candidate_key: string;
  readonly satisfied_by_candidate_key: string;
  readonly satisfied_head_slot: number;
  readonly displaced_head_baseline: Readonly<{
    readonly slot: number;
    readonly candidate_key: string;
  }> | null;
  readonly evicted_packet_baseline: Readonly<{
    readonly slot: number;
    readonly candidate_key: string;
  }> | null;
  readonly witness: Readonly<Record<string, unknown>>;
}>;

type V3Observation = RecallPacketPlanObservation & Readonly<{
  readonly membership_authorizations: readonly MembershipAuthorization[];
}>;

const BASELINE = Object.freeze([
  "workspace_local:memory_entry:source-a",
  "workspace_local:memory_entry:displaced-b",
  "workspace_local:memory_entry:baseline-c",
  "workspace_local:memory_entry:baseline-d",
  "workspace_local:memory_entry:baseline-e",
  "workspace_local:synthesis_capsule:evicted-f"
]);
const SATISFIED = "workspace_local:memory_entry:satisfied-x";

describe("packet-plan membership authorization receipts", () => {
  it.each([
    ["direct query evidence", directAuthorization()],
    ["graph path opportunity", graphAuthorization()],
    ["behavior identity", behaviorAuthorization()],
    ["selector consensus", selectorConsensusAuthorization()],
    ["same-session substitution", substitutionAuthorization()]
  ])("emits a frozen v3 receipt for %s", (_name, authorization) => {
    const trace = buildSupportSetPacketPlanTrace(
      "snapshot",
      acceptedObservation(authorization)
    );

    expect(trace).toMatchObject({
      schema_version: 3,
      membership_authorizations: [authorization]
    });
    expect(Object.isFrozen(trace.membership_authorizations)).toBe(true);
    expect(Object.isFrozen(trace.membership_authorizations[0])).toBe(true);
  });

  it("requires the v3 authorization array even when membership is unchanged", () => {
    const observation = acceptedObservation(directAuthorization());
    const { membership_authorizations: _omitted, ...withoutReceipts } = observation;

    expect(() => buildSupportSetPacketPlanTrace(
      "snapshot",
      withoutReceipts
    )).toThrow();
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
    }],
    ["evicted packet candidate", {
      evicted_packet_baseline: { slot: 6, candidate_key: BASELINE[4] }
    }]
  ])("rejects a receipt with a tampered %s binding", (_name, patch) => {
    const authorization = { ...directAuthorization(), ...patch };

    expect(() => buildSupportSetPacketPlanTrace(
      "snapshot",
      acceptedObservation(authorization)
    )).toThrow();
  });

  it.each([
    ["path target", { target_candidate_key: BASELINE[2] }],
    ["path id", { path_id: "" }],
    ["path source version", { path_source_version: " " }],
    ["relation kind", { relation_kind: "supports" }],
    ["graph rank", { graph_expansion_rank: 6 }],
    ["source-proximity rank", { source_proximity_rank: 0 }]
  ])("rejects a graph receipt with a tampered %s", (_name, witnessPatch) => {
    const valid = graphAuthorization();
    const authorization = {
      ...valid,
      witness: { ...valid.witness, ...witnessPatch }
    };

    expect(() => buildSupportSetPacketPlanTrace(
      "snapshot",
      acceptedObservation(authorization)
    )).toThrow();
  });

  it.each([
    ["behavior evidence", behaviorAuthorization(), { evidence_ref: " " }],
    ["substitution session", substitutionAuthorization(), { session_key: " " }]
  ])("rejects a blank %s witness", (_name, valid, witnessPatch) => {
    const authorization = {
      ...valid,
      witness: { ...valid.witness, ...witnessPatch }
    };

    expect(() => buildSupportSetPacketPlanTrace(
      "snapshot",
      acceptedObservation(authorization)
    )).toThrow();
  });
});

function buildSupportSetPacketPlanTrace(
  assessmentPath: "legacy" | "snapshot",
  observation: RecallPacketPlanObservation
) {
  assertRecallPacketPlanObservation(observation);
  const capture = captureSupportSetPacketPlanTrace(assessmentPath, observation);
  if (capture.status === "failed") throw new Error("Trace capture unexpectedly failed");
  return capture.trace;
}

function acceptedObservation(
  authorization: MembershipAuthorization
): V3Observation {
  const planned = Object.freeze([
    BASELINE[0]!, SATISFIED, BASELINE[2]!, BASELINE[3]!, BASELINE[4]!, BASELINE[1]!
  ]);
  return {
    baseline_candidate_keys: BASELINE,
    planned_candidate_keys: planned,
    actual_candidate_keys: planned,
    head_width: 5,
    baseline_head_candidate_keys: BASELINE.slice(0, 5),
    embedding_head: [],
    consensus_head_candidate_keys: planned.slice(0, 5),
    immutable_tail_candidate_keys: planned.slice(5),
    tail_policy: "nested_membership_exchange",
    membership_authorizations: Object.freeze([authorization]),
    protected_candidates: [],
    decision: { status: "accepted", reason: "nested_membership_consensus" }
  };
}

function authorizationBase(
  kind: MembershipAuthorization["kind"],
  authorizedCandidateKey = SATISFIED
) {
  return {
    kind,
    authorized_candidate_key: authorizedCandidateKey,
    satisfied_by_candidate_key: SATISFIED,
    satisfied_head_slot: 2,
    displaced_head_baseline: { slot: 2, candidate_key: BASELINE[1]! },
    evicted_packet_baseline: { slot: 6, candidate_key: BASELINE[5]! }
  } as const;
}

function directAuthorization(): MembershipAuthorization {
  return Object.freeze({
    ...authorizationBase("direct_query_evidence"),
    witness: Object.freeze({
      origin: "planned_tail_opportunity",
      stream: "lexical_fts",
      rank: 1,
      source_proximity_rank: 1,
      source_evidence_agreement_rank: 1
    })
  });
}

function graphAuthorization(): MembershipAuthorization {
  return Object.freeze({
    ...authorizationBase("graph_path_opportunity"),
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
}

function behaviorAuthorization(): MembershipAuthorization {
  return Object.freeze({
    ...authorizationBase("behavior_identity"),
    witness: Object.freeze({ evidence_ref: "evidence:verified-user-assertion" })
  });
}

function selectorConsensusAuthorization(): MembershipAuthorization {
  return Object.freeze({
    ...authorizationBase("selector_consensus"),
    witness: Object.freeze({ embedding_rank: 1 })
  });
}

function substitutionAuthorization(): MembershipAuthorization {
  return Object.freeze({
    ...authorizationBase("same_session_substitution", BASELINE[1]),
    witness: Object.freeze({
      protected_candidate_key: BASELINE[1],
      substitute_candidate_key: SATISFIED,
      session_key: "session-1",
      source_candidate_key: BASELINE[1],
      target_candidate_key: SATISFIED,
      path_id: "answers-with-path",
      path_source_version: "relation-version-1",
      relation_kind: "answers_with"
    })
  });
}
