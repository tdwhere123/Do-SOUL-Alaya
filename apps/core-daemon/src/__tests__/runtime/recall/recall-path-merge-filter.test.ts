import { describe, expect, it, vi } from "vitest";
import type { PathRelation } from "@do-soul/alaya-protocol";
import { createPreparedTemporalRecallPathReadPorts } from
  "../../../runtime/recall/recall-path-readers.js";

const workspaceId = "workspace-temporal-reader";

describe("createPreparedTemporalRecallPathReadPorts merge filter", () => {
  it("excludes a reader-returned as-of path that fails one merge eligibility filter", async () => {
    const eligible = createSoftAssociationPath("path-merge-eligible", "memory-c");
    const ineligible = {
      ...eligible,
      path_id: "path-merge-ineligible-governance",
      legitimacy: {
        ...eligible.legitimacy,
        governance_class: "recall_allowed" as const
      }
    };
    const options = { asOf: "2026-07-17T00:00:00.000Z" };
    expect(Date.parse(ineligible.created_at)).toBeLessThanOrEqual(Date.parse(options.asOf));
    expect(Date.parse(ineligible.updated_at)).toBeLessThanOrEqual(Date.parse(options.asOf));
    expect(ineligible.constitution.relation_kind).toBe("co_recalled");
    expect(ineligible.legitimacy.evidence_basis).toEqual(["recalls_edge_co_usage"]);
    expect(ineligible.legitimacy.governance_class).not.toBe("attention_only");
    const softAssociation = {
      findByAnchors: vi.fn(async () => [eligible, ineligible]),
      findActiveByWorkspace: vi.fn(async () => [eligible, ineligible])
    };
    const ports = createPreparedTemporalRecallPathReadPorts({
      findByAnchors: async () => [],
      findByTimeConcernWindowDigests: async () => [],
      findByWorkspace: async () => []
    }, softAssociation);

    await expect(ports.pathExpansionPort.findByAnchors(
      workspaceId,
      [{ kind: "object", object_id: "memory-a" }],
      options
    )).resolves.toEqual([eligible]);
    expect(softAssociation.findByAnchors).toHaveBeenCalledWith(
      workspaceId,
      [{ kind: "object", object_id: "memory-a" }],
      options
    );
  });
});

function createPathRelation(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-temporal-reader",
    workspace_id: workspaceId,
    anchors: {
      source_anchor: { kind: "object", object_id: "memory-a" },
      target_anchor: { kind: "time_concern", source_object_id: "memory-a", window_digest: "next_week" }
    },
    constitution: {
      relation_kind: "co_usage",
      why_this_relation_exists: ["test"]
    },
    effect_vector: {
      salience: 0.8,
      recall_bias: 0.8,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.8,
      direction_bias: "target_to_source",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-07-17T00:00:00.000Z"
    },
    lifecycle: {
      status: "active",
      retirement_rule: "janitor_ttl_low_strength"
    },
    ...overrides,
    legitimacy: {
      evidence_basis: ["evidence-test"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
}

function createSoftAssociationPath(pathId: string, targetObjectId: string): PathRelation {
  return {
    ...createPathRelation({
      path_id: pathId,
      anchors: {
        source_anchor: { kind: "object", object_id: "memory-a" },
        target_anchor: { kind: "object", object_id: targetObjectId }
      },
      constitution: {
        relation_kind: "co_recalled",
        why_this_relation_exists: ["earned co-recall"]
      }
    }),
    legitimacy: {
      evidence_basis: ["recalls_edge_co_usage"],
      governance_class: "attention_only"
    }
  };
}
