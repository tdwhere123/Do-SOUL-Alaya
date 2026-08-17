import { describe, expect, it } from "vitest";
import {
  CAUSAL_USAGE_OPERATOR_ID,
  CausalUsageReceiptSchema,
  hashCausalUsageId,
  type CausalUsageReceipt
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 as defaultFieldSha256 } from "../../shared/field-hash.js";
import {
  USAGE_MASS_CAP,
  projectSoftUsage,
  usageWeightFor
} from "../../governance/effects/causal-plasticity.js";

const T0 = "2026-08-16T00:00:00.000Z";
const T1 = "2026-08-16T00:00:01.000Z";

describe("causal plasticity", () => {
  it("gives delivery, inspection, and top-k membership zero weight", () => {
    expect(usageWeightFor("delivery")).toBe(0);
    expect(usageWeightFor("inspection")).toBe(0);
    expect(usageWeightFor("top_k")).toBe(0);
    expect(usageWeightFor("causal")).toBe(1);
  });

  it("counts a repeated causal identity once and ignores delivered-but-unused weight", () => {
    const used = receipt("use-1", "path-1", 1, "causal");
    const unused = receipt("delivery-1", "path-1", 0, "delivery");
    const first = projectSoftUsage([
      { receipt: used, channel: "usage" },
      { receipt: unused, channel: "usage" },
      { receipt: used, channel: "usage" }
    ], T0, 0);

    expect(first.mass).toBe(1);
    expect(first.hard_relation).toBe(false);
    expect(first.strength).toBeLessThan(1);
  });

  it("decays unique usage mass on an injected clock and applies inhibitory receipts", () => {
    const used = receipt("use-1", "path-1", 1, "causal");
    const inhibit = receipt("reject-1", "path-1", 1, "causal");
    const decayed = projectSoftUsage(
      [{ receipt: used, channel: "usage" }],
      T1,
      Math.log(2) / 1000
    );
    expect(decayed.mass).toBeCloseTo(0.5, 8);

    const inhibited = projectSoftUsage([
      { receipt: used, channel: "usage" },
      { receipt: inhibit, channel: "inhibitory" }
    ], T0, 0);
    expect(inhibited.mass).toBe(0);
    expect(inhibited.strength).toBe(0);
    expect(inhibited.hard_relation).toBe(false);
  });

  it("caps accumulated usage mass before projecting strength", () => {
    const credits = Array.from({ length: USAGE_MASS_CAP + 5 }, (_, index) => ({
      receipt: receipt(`use-${index}`, "path-1", 1, "causal"),
      channel: "usage" as const
    }));

    expect(projectSoftUsage(credits, T0, 0).mass).toBe(USAGE_MASS_CAP);
  });

  it("excludes receipts that had not occurred by the projection as-of", () => {
    const future = receipt("future-use", "path-1", 1, "causal", T1);

    expect(projectSoftUsage([{ receipt: future, channel: "usage" }], T0, 0)).toEqual({
      mass: 0,
      strength: 0,
      hard_relation: false
    });
  });
});

function receipt(
  causalKey: string,
  downstreamRef: string,
  weight: number,
  usageKind: "causal" | "delivery" | "inspection",
  occurredAt: string = T0
): CausalUsageReceipt {
  return CausalUsageReceiptSchema.parse({
    schema_version: 1,
    producer: CAUSAL_USAGE_OPERATOR_ID,
    consumer: "path_projection",
    identity: hashCausalUsageId({
      causal_key: causalKey,
      downstream_ref: downstreamRef,
      scope: "workspace-1",
      operator_id: CAUSAL_USAGE_OPERATOR_ID
    }, defaultFieldSha256),
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "retain_identity",
    workspace_id: "workspace-1",
    causal_key: causalKey,
    occurred_at: occurredAt,
    downstream_ref: downstreamRef,
    weight,
    scope: "workspace-1",
    usage_kind: usageKind,
    operator_id: CAUSAL_USAGE_OPERATOR_ID,
    recorded_at: occurredAt
  });
}
