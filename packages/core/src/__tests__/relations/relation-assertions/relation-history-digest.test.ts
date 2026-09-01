import { describe, expect, it } from "vitest";
import {
  EMPTY_RELATION_HISTORY_DIGEST,
  type RelationAssertion
} from "@do-soul/alaya-protocol";
import { LEGACY_STRUCTURED_EMPTY_HISTORY_DIGEST } from "../../../path-graph/relation-assertions/legacy-empty-history-digest.js";
import { buildRelationProjection } from "../../../relations/relation-assertions/relation-projection-builder.js";

const asOf = "2026-07-17T01:30:00.000Z";
const earlierAsOf = "2026-07-16T12:00:00.000Z";

describe("relation history digest", () => {
  it("returns the shared bootstrap identity for empty relation history", () => {
    const projection = buildRelationProjection([], [], asOf, new Set());
    expect(projection.generation.historyDigest).toBe(EMPTY_RELATION_HISTORY_DIGEST);
    expect(projection.activeProjectionCount).toBe(0);
  });

  it("uses a non-empty history identity when history exists but no projection is active", () => {
    const projection = buildRelationProjection([createAssertion()], [], earlierAsOf, new Set());

    expect(projection.activeProjectionCount).toBe(0);
    expect(projection.generation.projections).toEqual([]);
    expect(projection.generation.asOf).toBe(earlierAsOf);
    expect(projection.generation.historyDigest).not.toBe(EMPTY_RELATION_HISTORY_DIGEST);
    expect(projection.generation.historyDigest).not.toBe(LEGACY_STRUCTURED_EMPTY_HISTORY_DIGEST);
  });
});

function createAssertion(): RelationAssertion {
  return {
    assertion_id: "assertion-1",
    workspace_id: "workspace-1",
    admission_event_id: "event-1",
    evidence_receipts: [{
      evidence_id: "evidence-1",
      source_event_anchor: {
        event_type: "soul.signal.emitted",
        event_id: "source-event-1",
        occurred_at: "2026-07-16T23:59:00.000Z"
      }
    }],
    formation_receipt: {
      operator_id: "test_relation_operator_v1",
      operator_sha256: "a".repeat(64),
      parameters: { threshold: 3 },
      parameter_sha256: "b".repeat(64),
      source_observations: [{
        source_kind: "event_log_entry",
        source_id: "observation-1",
        source_sha256: "c".repeat(64)
      }],
      decision: { matched: true },
      decision_sha256: "d".repeat(64)
    },
    anchors: {
      source_anchor: { kind: "object", object_id: "object-1" },
      target_anchor: { kind: "object", object_id: "object-2" }
    },
    relation_kind: "supports",
    validity: { kind: "open", valid_from: asOf },
    admitted_at: asOf
  };
}
