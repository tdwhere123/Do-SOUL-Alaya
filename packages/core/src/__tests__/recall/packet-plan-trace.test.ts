import { describe, expect, it } from "vitest";
import {
  buildSupportSetPacketPlanTrace,
  type RecallPacketPlanObservation
} from "../../recall/delivery/packet-plan/packet-plan-trace.js";

describe("support-set packet plan trace", () => {
  it("freezes an accepted IDs-only trace whose planned packet is actual", () => {
    const trace = buildSupportSetPacketPlanTrace(
      "snapshot",
      acceptedObservation()
    );

    expect(trace).toEqual({
      schema_version: 2,
      assessment_path: "snapshot",
      ...acceptedObservation(),
      added_candidate_keys: ["global:evidence_capsule:added-d"],
      removed_candidate_keys: ["workspace_local:synthesis_capsule:tail-c"]
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

  it("records a rejected proposal while preserving the actual baseline", () => {
    const accepted = acceptedObservation();
    const rejected: RecallPacketPlanObservation = {
      ...accepted,
      actual_candidate_keys: accepted.baseline_candidate_keys,
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

  it("rejects a decision reason that contradicts its observed proposal", () => {
    const accepted = acceptedObservation();
    expect(() => buildSupportSetPacketPlanTrace("snapshot", {
      ...accepted,
      actual_candidate_keys: accepted.baseline_candidate_keys,
      decision: {
        status: "rejected",
        reason: "behavior_guard_full_abort"
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
});

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
      "global:evidence_capsule:baseline-b"
    ],
    actual_candidate_keys: [
      "workspace_local:memory_entry:baseline-a",
      "global:evidence_capsule:added-d",
      "global:evidence_capsule:baseline-b"
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
