import { describe, expect, it } from "vitest";
import {
  CAUSAL_USAGE_OPERATOR_ID,
  CausalUsageReceiptSchema,
  hashCausalUsageId,
  type CausalUsageReceipt,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { projectCausalUsageOntoPaths } from "../../relations/path-plasticity/causal-usage-projection.js";

const AS_OF = "2026-08-17T00:00:00.000Z";

describe("causal usage temporal path projection", () => {
  it("projects canonical unique usage without mutating the stored temporal row", () => {
    const stored = path("path-1", 0.2);
    const used = receipt("outcome-1", "memory-2", "2026-08-16T00:00:00.000Z");

    const [projected] = projectCausalUsageOntoPaths(
      [stored],
      [used, used],
      AS_OF,
      0
    );

    const usageStrength = 1 - Math.exp(-1);
    expect(projected?.plasticity_state.strength).toBeCloseTo(
      1 - (1 - 0.2) * (1 - usageStrength),
      10
    );
    expect(projected?.plasticity_state.support_events_count).toBe(1);
    expect(stored.plasticity_state.strength).toBe(0.2);
  });

  it("preserves existing support history while composing bounded usage strength", () => {
    const stored = {
      ...path("path-1", 0.75),
      plasticity_state: {
        ...path("path-1", 0.75).plasticity_state,
        support_events_count: 4,
        last_reinforced_at: "2026-08-10T00:00:00.000Z"
      }
    } satisfies PathRelation;

    const [projected] = projectCausalUsageOntoPaths(
      [stored],
      [receipt("outcome-1", "memory-2", "2026-08-16T00:00:00.000Z")],
      AS_OF,
      0
    );

    expect(projected?.plasticity_state.strength).toBeGreaterThan(0.75);
    expect(projected?.plasticity_state.strength).toBeLessThanOrEqual(1);
    expect(projected?.plasticity_state.support_events_count).toBe(5);
    expect(projected?.plasticity_state.last_reinforced_at).toBe("2026-08-16T00:00:00.000Z");
  });

  it("does not credit unrelated or future causal usage", () => {
    const projected = projectCausalUsageOntoPaths(
      [path("path-1", 0.2)],
      [
        receipt("unrelated", "memory-3", "2026-08-16T00:00:00.000Z"),
        receipt("future", "memory-2", "2026-08-18T00:00:00.000Z")
      ],
      AS_OF,
      0
    );

    expect(projected[0]?.plasticity_state.strength).toBe(0.2);
    expect(projected[0]?.plasticity_state.support_events_count).toBe(0);
  });
});

function receipt(causalKey: string, downstreamRef: string, occurredAt: string): CausalUsageReceipt {
  return CausalUsageReceiptSchema.parse({
    schema_version: 1,
    producer: CAUSAL_USAGE_OPERATOR_ID,
    consumer: "path_projection",
    identity: hashCausalUsageId({
      causal_key: causalKey,
      downstream_ref: downstreamRef,
      scope: "workspace-1",
      operator_id: CAUSAL_USAGE_OPERATOR_ID
    }, fieldContractSha256),
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "retain_identity",
    workspace_id: "workspace-1",
    causal_key: causalKey,
    occurred_at: occurredAt,
    downstream_ref: downstreamRef,
    weight: 1,
    scope: "workspace-1",
    usage_kind: "causal",
    operator_id: CAUSAL_USAGE_OPERATOR_ID,
    recorded_at: occurredAt
  });
}

function path(pathId: string, strength: number): PathRelation {
  return {
    path_id: pathId,
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "memory-1" },
      target_anchor: { kind: "object", object_id: "memory-2" }
    },
    constitution: { relation_kind: "supports", why_this_relation_exists: ["evidence"] },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength,
      direction_bias: "source_to_target",
      stability_class: "normal",
      support_events_count: 0,
      contradiction_events_count: 0
    },
    lifecycle: { status: "active", retirement_rule: "default" },
    legitimacy: { evidence_basis: ["evidence-1"], governance_class: "attention_only" },
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z"
  };
}
