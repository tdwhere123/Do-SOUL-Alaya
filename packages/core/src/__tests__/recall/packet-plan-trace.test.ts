import {
  MemoryDimension,
  RecallCandidateSchema,
  ScopeClass
} from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import {
  buildObservedPacketPlanTrace
} from "../../recall/delivery/packet-plan/packet-plan-trace.js";

describe("observed packet plan trace", () => {
  it("freezes ordered candidate keys without retaining content or gold data", () => {
    const baseline = [
      candidate("baseline-a", "memory_entry", "baseline private content"),
      candidate(
        "baseline-b",
        "evidence_capsule",
        "evidence private content",
        "global"
      )
    ];
    const actual = [
      baseline[1],
      candidate("actual-c", "synthesis_capsule", "actual private content")
    ];

    const trace = buildObservedPacketPlanTrace("legacy", baseline, actual);

    expect(trace).toEqual({
      schema_version: 1,
      assessment_path: "legacy",
      baseline_candidate_keys: [
        "workspace_local:memory_entry:baseline-a",
        "global:evidence_capsule:baseline-b"
      ],
      planned_candidate_keys: null,
      actual_candidate_keys: [
        "global:evidence_capsule:baseline-b",
        "workspace_local:synthesis_capsule:actual-c"
      ],
      decision: {
        status: "not_attempted",
        challenger_candidate_key: null,
        victim_candidate_key: null,
        reason: null
      }
    });
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace.baseline_candidate_keys)).toBe(true);
    expect(Object.isFrozen(trace.actual_candidate_keys)).toBe(true);
    expect(Object.isFrozen(trace.decision)).toBe(true);

    const serialized = JSON.stringify(trace);
    expect(serialized).not.toMatch(/private content|content_preview|gold/iu);
  });
});

function candidate(
  objectId: string,
  objectKind: "memory_entry" | "synthesis_capsule" | "evidence_capsule",
  contentPreview: string,
  originPlane?: "workspace_local" | "global"
) {
  return RecallCandidateSchema.parse({
    object_id: objectId,
    object_kind: objectKind,
    activation_score: 0.8,
    relevance_score: 0.9,
    content_preview: contentPreview,
    token_estimate: 8,
    manifestation: "full_eligible",
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.PROJECT,
    ...(originPlane === undefined ? {} : { origin_plane: originPlane })
  });
}
