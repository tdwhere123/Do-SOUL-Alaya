import { describe, expect, it, vi } from "vitest";
import type { PathRelation } from "@do-soul/alaya-protocol";
import { createRecallGraphExplorePathReader } from "../../../runtime/recall/recall-graph-path-reader.js";
import { createRecallPathReadPorts } from "../../../runtime/recall/recall-path-readers.js";

describe("createRecallGraphExplorePathReader", () => {
  it("derives every graph lookup from the selected composite read ports", async () => {
    const path = createPathRelation();
    const sourceOnlyPath = createPathRelation({
      path_id: "path-source-only",
      anchors: {
        source_anchor: path.anchors.target_anchor,
        target_anchor: { kind: "object", object_id: "memory-c" }
      }
    });
    const temporal = {
      findByAnchors: vi.fn(async () => [path, sourceOnlyPath]),
      findByTimeConcernWindowDigests: vi.fn(async () => [path]),
      findByWorkspace: vi.fn(async () => [path])
    };
    const options = { asOf: "2026-07-16T00:00:00.000Z" };
    const ensureTemporalProjection = vi.fn(async () => undefined);
    const graphReader = createRecallGraphExplorePathReader(createRecallPathReadPorts({
      temporalProjectionSelected: true,
      temporalPathProjectionReader: temporal,
      ensureTemporalProjection
    }), options);

    await expect(graphReader.findByTargetAnchor("workspace-1", {
      kind: "time_concern",
      source_object_id: "memory-a",
      window_digest: "next_week"
    })).resolves.toEqual([path]);
    await expect(graphReader.findByBackingObjectIds("workspace-1", ["memory-a"]))
      .resolves.toEqual([path]);
    await expect(graphReader.findByBackingObjectId("workspace-1", "memory-b"))
      .resolves.toEqual([]);

    expect(temporal.findByAnchors).toHaveBeenCalledWith(
      "workspace-1",
      [path.anchors.target_anchor],
      options
    );
    expect(temporal.findByWorkspace).toHaveBeenCalledTimes(2);
    expect(ensureTemporalProjection).toHaveBeenCalledTimes(3);
  });

  it("keeps an active soft edge when a dormant legacy row has the same identity", async () => {
    const soft = createPathRelation({
      path_id: "path-soft-active",
      anchors: {
        source_anchor: { kind: "object", object_id: "memory-a" },
        target_anchor: { kind: "object", object_id: "memory-b" }
      },
      constitution: {
        relation_kind: "co_recalled",
        why_this_relation_exists: ["earned co-recall"]
      },
      legitimacy: {
        evidence_basis: ["recalls_edge_co_usage"],
        governance_class: "attention_only"
      }
    });
    const dormantLegacy = {
      ...soft,
      path_id: "path-legacy-dormant",
      lifecycle: { ...soft.lifecycle, status: "dormant" as const }
    };
    const readPorts = createRecallPathReadPorts({
      legacyPathReader: {
        findByAnchors: vi.fn(async () => [dormantLegacy]),
        findByWorkspaceAll: vi.fn(async () => [dormantLegacy]),
        findActiveAll: vi.fn(async () => [])
      },
      softAssociationPathReader: {
        findByAnchors: vi.fn(async () => [soft]),
        findActiveByWorkspace: vi.fn(async () => [soft])
      }
    });
    const graphReader = createRecallGraphExplorePathReader(readPorts);

    await expect(graphReader.findByTargetAnchor("workspace-1", {
      kind: "object",
      object_id: "memory-b"
    })).resolves.toEqual([soft]);
    await expect(graphReader.findByBackingObjectId("workspace-1", "memory-b"))
      .resolves.toEqual([soft]);
  });
});

function createPathRelation(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-graph-reader",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "memory-a" },
      target_anchor: {
        kind: "time_concern",
        source_object_id: "memory-a",
        window_digest: "next_week"
      }
    },
    constitution: { relation_kind: "co_usage", why_this_relation_exists: ["test"] },
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
    lifecycle: { status: "active", retirement_rule: "janitor_ttl_low_strength" },
    legitimacy: { evidence_basis: ["evidence-test"], governance_class: "recall_allowed" },
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z",
    ...overrides
  };
}
