import { describe, expect, it } from "vitest";
import {
  assertRecallPacketPlanObservation,
  type RecallPacketMembershipAuthorization,
  type RecallPacketPlanObservation
} from "../../recall/delivery/packet-plan/packet-plan-observation.js";
import { captureSupportSetPacketPlanTrace } from
  "../../recall/delivery/packet-plan/packet-plan-trace.js";

describe("support-set packet plan trace", () => {
  it("freezes an accepted IDs-only trace whose planned packet is actual", () => {
    const trace = buildSupportSetPacketPlanTrace(
      "snapshot",
      acceptedObservation()
    );

    expect(trace).toEqual({
      schema_version: 3,
      assessment_path: "snapshot",
      ...acceptedObservation(),
      added_candidate_keys: ["global:evidence_capsule:added-d"],
      removed_candidate_keys: ["global:evidence_capsule:baseline-b"]
    });
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace.embedding_head)).toBe(true);
    expect(Object.isFrozen(trace.protected_candidates)).toBe(true);
    expect(Object.isFrozen(trace.decision)).toBe(true);
    expect(JSON.stringify(trace)).not.toMatch(
      /private content|content_preview|gold|activation_score|relevance_score/iu
    );
  });

  it("records a no-op as the exact baseline with no packet delta", () => {
    const baseline = ["workspace_local:memory_entry:baseline-a"];
    const observation: RecallPacketPlanObservation = {
      baseline_candidate_keys: baseline,
      planned_candidate_keys: baseline,
      actual_candidate_keys: baseline,
      head_width: 1,
      baseline_head_candidate_keys: baseline,
      embedding_head: [],
      consensus_head_candidate_keys: baseline,
      immutable_tail_candidate_keys: [],
      membership_authorizations: [],
      protected_candidates: [],
      decision: {
        status: "no_op",
        reason: "no_finite_embedding_head"
      }
    };

    const trace = buildSupportSetPacketPlanTrace("legacy", observation);

    expect(trace.added_candidate_keys).toEqual([]);
    expect(trace.removed_candidate_keys).toEqual([]);
    expect(trace.decision).toEqual(observation.decision);
  });

  it.each([
    ["non-no-op status", {
      decision: { status: "accepted", reason: "select_gamma_identity" }
    }],
    ["protected candidate", {
      protected_candidates: [{ candidate_key: "candidate-1", rank_limit: 1 }]
    }],
    ["consensus rank basis", {
      embedding_rank_basis: "source_semantic_rrf",
      source_semantic_intermediate_candidate_keys: ["candidate-1"]
    }]
  ])("rejects Select_Gamma identity with %s", (_name, patch) => {
    const baseline = ["candidate-1"];
    const observation = {
      baseline_candidate_keys: baseline,
      planned_candidate_keys: baseline,
      actual_candidate_keys: baseline,
      head_width: 1,
      baseline_head_candidate_keys: baseline,
      embedding_head: [],
      consensus_head_candidate_keys: baseline,
      immutable_tail_candidate_keys: [],
      membership_authorizations: [],
      protected_candidates: [],
      decision: { status: "no_op", reason: "select_gamma_identity" },
      ...patch
    } as unknown as RecallPacketPlanObservation;

    expect(() => assertRecallPacketPlanObservation(observation)).toThrow();
  });

  it("accepts membership consensus without an embedding head", () => {
    const accepted = acceptedObservation();
    const planned = [
      accepted.baseline_candidate_keys[0]!,
      accepted.baseline_candidate_keys[2]!,
      "workspace_local:memory_entry:added-d"
    ];
    const observation: RecallPacketPlanObservation = {
      ...accepted,
      planned_candidate_keys: planned,
      actual_candidate_keys: planned,
      head_width: 3,
      baseline_head_candidate_keys: accepted.baseline_candidate_keys,
      embedding_head: [],
      consensus_head_candidate_keys: planned,
      immutable_tail_candidate_keys: [],
      tail_policy: "nested_membership_exchange",
      membership_authorizations: [directAuthorization(
        planned[2]!, 3, accepted.baseline_candidate_keys[2]!,
        accepted.baseline_candidate_keys[1]!
      )],
      decision: {
        status: "accepted",
        reason: "nested_membership_consensus"
      }
    };

    expect(buildSupportSetPacketPlanTrace("snapshot", observation).decision)
      .toEqual(observation.decision);
  });

  it("rejects a nested trace with a forged baseline prefix", () => {
    const accepted = acceptedObservation();
    const planned = [
      accepted.baseline_candidate_keys[0]!,
      accepted.baseline_candidate_keys[2]!,
      "workspace_local:memory_entry:added-d"
    ];
    expect(() => buildSupportSetPacketPlanTrace("snapshot", {
      ...accepted,
      planned_candidate_keys: planned,
      actual_candidate_keys: planned,
      head_width: 3,
      baseline_head_candidate_keys: [...accepted.baseline_candidate_keys].reverse(),
      embedding_head: [],
      consensus_head_candidate_keys: planned,
      immutable_tail_candidate_keys: [],
      tail_policy: "nested_membership_exchange",
      membership_authorizations: [directAuthorization(
        planned[2]!, 3, accepted.baseline_candidate_keys[2]!,
        accepted.baseline_candidate_keys[1]!
      )],
      decision: { status: "accepted", reason: "nested_membership_consensus" }
    })).toThrow();
  });

  it("rejects a membership receipt bound to an unrelated source", () => {
    const accepted = acceptedObservation();
    const planned = [
      accepted.baseline_candidate_keys[0]!,
      accepted.baseline_candidate_keys[2]!,
      "workspace_local:memory_entry:added-d"
    ];
    expect(() => buildSupportSetPacketPlanTrace("snapshot", {
      ...accepted,
      planned_candidate_keys: planned,
      actual_candidate_keys: planned,
      head_width: 3,
      baseline_head_candidate_keys: accepted.baseline_candidate_keys,
      embedding_head: [],
      consensus_head_candidate_keys: planned,
      immutable_tail_candidate_keys: [],
      tail_policy: "nested_membership_exchange",
      membership_authorizations: [{
        ...directAuthorization(
          planned[2]!, 3, accepted.baseline_candidate_keys[2]!,
          accepted.baseline_candidate_keys[1]!
        ),
        authorized_candidate_key: accepted.baseline_candidate_keys[0]!
      }],
      decision: { status: "accepted", reason: "nested_membership_consensus" }
    })).toThrow();
  });

  it("rejects an unauthorized permutation of the baseline head", () => {
    const accepted = acceptedObservation();
    const consensusHead = [...accepted.baseline_head_candidate_keys].reverse();
    const planned = [
      ...consensusHead,
      ...accepted.immutable_tail_candidate_keys
    ];

    expect(() => assertRecallPacketPlanObservation({
      ...accepted,
      planned_candidate_keys: planned,
      actual_candidate_keys: planned,
      consensus_head_candidate_keys: consensusHead,
      embedding_head: consensusHead.map((candidateKey, index) => ({
        candidate_key: candidateKey,
        embedding_rank: index + 1
      })),
      membership_authorizations: [],
      decision: { status: "accepted", reason: "strict_tail_consensus" }
    })).toThrow();
  });

  it("rejects a new head member disguised as a protected baseline candidate", () => {
    const accepted = acceptedObservation();
    const introduced = accepted.consensus_head_candidate_keys[1]!;

    expect(() => assertRecallPacketPlanObservation({
      ...accepted,
      membership_authorizations: [],
      protected_candidates: [{ candidate_key: introduced, rank_limit: 2 }]
    })).toThrow();
  });

  it.each([
    ["intermediate packet", "source_semantic_intermediate_candidate_keys"],
    ["packet-relative head", "packet_relative_embedding_head"]
  ])("rejects a composite rank basis without its %s", (_name, omitted) => {
    const accepted = acceptedObservation();
    const composite = {
      ...accepted,
      embedding_rank_basis: "source_semantic_rrf_then_packet_relative" as const,
      source_semantic_intermediate_candidate_keys: accepted.planned_candidate_keys,
      packet_relative_embedding_head: accepted.embedding_head
    };
    delete (composite as Record<string, unknown>)[omitted];

    expect(() => assertRecallPacketPlanObservation(
      composite as RecallPacketPlanObservation
    )).toThrow();
  });

  it.each([
    ["embedding stream", { stream: "embedding_similarity" }],
    ["out-of-head direct rank", { rank: 3 }],
    ["zero source-proximity rank", { source_proximity_rank: 0 }],
    ["zero evidence-agreement rank", { source_evidence_agreement_rank: 0 }]
  ])("rejects direct evidence with an invalid %s", (_name, witnessPatch) => {
    const accepted = acceptedObservation();
    const authorization = accepted.membership_authorizations[0]!;
    if (authorization.kind !== "direct_query_evidence") {
      throw new Error("Expected direct authorization fixture");
    }
    expect(() => assertRecallPacketPlanObservation({
      ...accepted,
      membership_authorizations: [{
        ...authorization,
        witness: { ...authorization.witness, ...witnessPatch }
      }]
    } as unknown as RecallPacketPlanObservation)).toThrow();
  });

  it("records a rejected proposal while preserving the actual baseline", () => {
    const accepted = acceptedObservation();
    const rejected: RecallPacketPlanObservation = {
      ...accepted,
      actual_candidate_keys: accepted.baseline_candidate_keys,
      membership_authorizations: [],
      protected_candidates: [{
        candidate_key: "global:evidence_capsule:baseline-b",
        rank_limit: 2
      }],
      decision: {
        status: "rejected",
        reason: "protected_candidate_constraint"
      }
    };

    const trace = buildSupportSetPacketPlanTrace("snapshot", rejected);

    expect(trace.planned_candidate_keys).not.toEqual(trace.actual_candidate_keys);
    expect(trace.actual_candidate_keys).toEqual(trace.baseline_candidate_keys);
  });

  it("accepts strict-tail admission failure without a nested tail policy", () => {
    const accepted = acceptedObservation();
    const observation: RecallPacketPlanObservation = {
      ...accepted,
      actual_candidate_keys: accepted.baseline_candidate_keys,
      decision: { status: "rejected", reason: "admission_infeasible" }
    };

    expect(buildSupportSetPacketPlanTrace("snapshot", observation).decision)
      .toEqual(observation.decision);
  });

  it("accepts nested admission failure with its tail policy", () => {
    const accepted = acceptedObservation();
    const planned = [
      accepted.baseline_candidate_keys[0]!,
      accepted.baseline_candidate_keys[2]!,
      "workspace_local:memory_entry:added-d"
    ];
    const observation: RecallPacketPlanObservation = {
      ...accepted,
      planned_candidate_keys: planned,
      actual_candidate_keys: accepted.baseline_candidate_keys,
      head_width: 3,
      baseline_head_candidate_keys: accepted.baseline_candidate_keys,
      embedding_head: [],
      consensus_head_candidate_keys: planned,
      immutable_tail_candidate_keys: [],
      tail_policy: "nested_membership_exchange",
      membership_authorizations: [directAuthorization(
        planned[2]!, 3, accepted.baseline_candidate_keys[2]!,
        accepted.baseline_candidate_keys[1]!
      )],
      decision: { status: "rejected", reason: "admission_infeasible" }
    };

    expect(buildSupportSetPacketPlanTrace("snapshot", observation).decision)
      .toEqual(observation.decision);
  });

  it("rejects strict_tail_consensus when published heads are unchanged", () => {
    const accepted = acceptedObservation();
    const planned = [
      ...accepted.baseline_head_candidate_keys,
      ...accepted.immutable_tail_candidate_keys
    ];
    expect(() => assertRecallPacketPlanObservation({
      ...accepted,
      planned_candidate_keys: planned,
      actual_candidate_keys: planned,
      consensus_head_candidate_keys: accepted.baseline_head_candidate_keys,
      membership_authorizations: [],
      decision: { status: "accepted", reason: "strict_tail_consensus" }
    })).toThrow(/Changed consensus decision is inconsistent/u);
  });

  it("rejects a decision reason that contradicts its observed proposal", () => {
    const accepted = acceptedObservation();
    expect(() => buildSupportSetPacketPlanTrace("snapshot", {
      ...accepted,
      actual_candidate_keys: accepted.baseline_candidate_keys,
      decision: {
        status: "rejected",
        reason: "protected_candidate_constraint"
      },
      embedding_head: [],
      consensus_head_candidate_keys: accepted.baseline_head_candidate_keys,
      planned_candidate_keys: accepted.baseline_candidate_keys
    })).toThrow();
  });

  it.each([
    {
      name: "accepted actual",
      mutate: (value: RecallPacketPlanObservation) => ({
        ...value,
        actual_candidate_keys: value.baseline_candidate_keys
      })
    },
    {
      name: "baseline partition",
      mutate: (value: RecallPacketPlanObservation) => ({
        ...value,
        immutable_tail_candidate_keys: []
      })
    },
    {
      name: "embedding rank",
      mutate: (value: RecallPacketPlanObservation) => ({
        ...value,
        embedding_head: [{
          ...value.embedding_head[0]!,
          embedding_rank: value.head_width + 1
        }]
      })
    }
  ])("rejects an inconsistent $name", ({ mutate }) => {
    expect(() => buildSupportSetPacketPlanTrace(
      "snapshot",
      mutate(acceptedObservation())
    )).toThrow();
  });

  it("contains an unexpected trace projection fault", () => {
    const observation = new Proxy(acceptedObservation(), {
      get(target, property, receiver) {
        if (property === "baseline_candidate_keys") {
          throw new Error("injected projection fault");
        }
        return Reflect.get(target, property, receiver);
      }
    });

    expect(captureSupportSetPacketPlanTrace("snapshot", observation))
      .toEqual({
        status: "failed",
        failure: {
          code: "packet_plan_trace_projection_failed",
          error_name: "Error"
        }
      });
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

function acceptedObservation(): RecallPacketPlanObservation {
  return {
    baseline_candidate_keys: [
      "workspace_local:memory_entry:baseline-a",
      "global:evidence_capsule:baseline-b",
      "workspace_local:synthesis_capsule:tail-c"
    ],
    planned_candidate_keys: [
      "workspace_local:memory_entry:baseline-a",
      "global:evidence_capsule:added-d",
      "workspace_local:synthesis_capsule:tail-c"
    ],
    actual_candidate_keys: [
      "workspace_local:memory_entry:baseline-a",
      "global:evidence_capsule:added-d",
      "workspace_local:synthesis_capsule:tail-c"
    ],
    head_width: 2,
    baseline_head_candidate_keys: [
      "workspace_local:memory_entry:baseline-a",
      "global:evidence_capsule:baseline-b"
    ],
    embedding_head: [{
      candidate_key: "global:evidence_capsule:added-d",
      embedding_rank: 1
    }],
    consensus_head_candidate_keys: [
      "workspace_local:memory_entry:baseline-a",
      "global:evidence_capsule:added-d"
    ],
    immutable_tail_candidate_keys: [
      "workspace_local:synthesis_capsule:tail-c"
    ],
    membership_authorizations: [directAuthorization(
      "global:evidence_capsule:added-d",
      2,
      "global:evidence_capsule:baseline-b",
      "global:evidence_capsule:baseline-b"
    )],
    protected_candidates: [{
      candidate_key: "workspace_local:memory_entry:baseline-a",
      rank_limit: 1
    }],
    decision: {
      status: "accepted",
      reason: "strict_tail_consensus"
    }
  };
}

function directAuthorization(
  candidateKey: string,
  slot: number,
  displacedKey: string,
  evictedKey: string
): RecallPacketMembershipAuthorization {
  return {
    kind: "direct_query_evidence",
    authorized_candidate_key: candidateKey,
    satisfied_by_candidate_key: candidateKey,
    satisfied_head_slot: slot,
    displaced_head_baseline: { slot, candidate_key: displacedKey },
    evicted_packet_baseline: {
      slot: acceptedBaseline().indexOf(evictedKey) + 1,
      candidate_key: evictedKey
    },
    witness: {
      origin: "proposed_head",
      stream: "lexical_fts",
      rank: 1,
      source_proximity_rank: 1,
      source_evidence_agreement_rank: 1
    }
  };
}

function acceptedBaseline(): readonly string[] {
  return [
    "workspace_local:memory_entry:baseline-a",
    "global:evidence_capsule:baseline-b",
    "workspace_local:synthesis_capsule:tail-c"
  ];
}
