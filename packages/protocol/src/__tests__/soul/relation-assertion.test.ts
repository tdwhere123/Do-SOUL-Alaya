import { describe, expect, it } from "vitest";
import {
  RelationAssertionResolutionSchema,
  RelationAssertionSchema,
  RelationValiditySchema,
  isRelationValidityActiveAt
} from "../../index.js";

const admittedAt = "2026-07-17T00:00:00.000Z";

function assertionWith(validity: unknown) {
  return {
    assertion_id: "assertion-1",
    workspace_id: "workspace-1",
    admission_event_id: "event-1",
    evidence_ids: ["evidence-1"],
    anchors: {
      source_anchor: { kind: "object", object_id: "object-1" },
      target_anchor: { kind: "object", object_id: "object-2" }
    },
    relation_kind: "supports",
    validity,
    admitted_at: admittedAt
  };
}

describe("RelationAssertion temporal contract", () => {
  it("accepts only explicit bounded, open, or timeless validity", () => {
    const bounded = RelationValiditySchema.parse({
      kind: "bounded",
      valid_from: "2026-07-01T00:00:00.000Z",
      valid_to: "2026-08-01T00:00:00.000Z"
    });
    const open = RelationValiditySchema.parse({
      kind: "open",
      valid_from: "2026-07-01T00:00:00.000Z"
    });
    const timeless = RelationValiditySchema.parse({
      kind: "timeless",
      governance_policy_id: "timeless-policy-1"
    });

    expect(bounded.kind).toBe("bounded");
    expect(open.kind).toBe("open");
    expect(timeless.kind).toBe("timeless");
    expect(() => RelationValiditySchema.parse({ kind: "unknown" })).toThrow();
    expect(() =>
      RelationValiditySchema.parse({
        kind: "bounded",
        valid_from: "2026-08-01T00:00:00.000Z",
        valid_to: "2026-08-01T00:00:00.000Z"
      })
    ).toThrow();
  });

  it("requires evidence and EventLog admission identity for immutable truth", () => {
    const assertion = RelationAssertionSchema.parse(
      assertionWith({
        kind: "open",
        valid_from: "2026-07-01T00:00:00.000Z"
      })
    );

    expect(assertion.admission_event_id).toBe("event-1");
    expect(assertion.evidence_ids).toEqual(["evidence-1"]);
    expect(() =>
      RelationAssertionSchema.parse({
        ...assertionWith({ kind: "timeless", governance_policy_id: "timeless-policy-1" }),
        evidence_ids: []
      })
    ).toThrow();
  });

  it("uses [from,to), open, and timeless semantics for an as_of projection", () => {
    const bounded = RelationValiditySchema.parse({
      kind: "bounded",
      valid_from: "2026-07-01T00:00:00.000Z",
      valid_to: "2026-07-02T00:00:00.000Z"
    });
    const open = RelationValiditySchema.parse({
      kind: "open",
      valid_from: "2026-07-01T00:00:00.000Z"
    });
    const timeless = RelationValiditySchema.parse({
      kind: "timeless",
      governance_policy_id: "timeless-policy-1"
    });

    const noTimelessPolicies = new Set<string>();
    const permittedTimelessPolicies = new Set(["timeless-policy-1"]);

    expect(isRelationValidityActiveAt(bounded, "2026-07-01T00:00:00.000Z", noTimelessPolicies)).toBe(true);
    expect(isRelationValidityActiveAt(bounded, "2026-07-01T23:59:59.999Z", noTimelessPolicies)).toBe(true);
    expect(isRelationValidityActiveAt(bounded, "2026-07-02T00:00:00.000Z", noTimelessPolicies)).toBe(false);
    expect(isRelationValidityActiveAt(open, "2026-06-30T23:59:59.999Z", noTimelessPolicies)).toBe(false);
    expect(isRelationValidityActiveAt(open, "2026-07-02T00:00:00.000Z", noTimelessPolicies)).toBe(true);
    expect(isRelationValidityActiveAt(timeless, "1900-01-01T00:00:00.000Z", noTimelessPolicies)).toBe(false);
    expect(
      isRelationValidityActiveAt(timeless, "1900-01-01T00:00:00.000Z", permittedTimelessPolicies)
    ).toBe(true);
  });

  it("accepts only typed append-only resolution kinds", () => {
    expect(
      RelationAssertionResolutionSchema.parse({
        resolution_id: "resolution-1",
        assertion_id: "assertion-1",
        workspace_id: "workspace-1",
        resolution_kind: "superseded",
        event_id: "event-2",
        resolved_at: admittedAt,
        reason: "newer evidence"
      }).resolution_kind
    ).toBe("superseded");
    expect(() =>
      RelationAssertionResolutionSchema.parse({
        resolution_id: "resolution-1",
        assertion_id: "assertion-1",
        workspace_id: "workspace-1",
        resolution_kind: "deleted",
        event_id: "event-2",
        resolved_at: admittedAt,
        reason: "not a typed history resolution"
      })
    ).toThrow();
  });
});
