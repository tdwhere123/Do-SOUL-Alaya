import { describe, expect, it } from "vitest";
import {
  ASSOCIATION_DOMAIN_ID,
  FieldActivationSchema,
  ProjectedCapSchema,
  RawMeasurementSchema,
  fieldActivationOf,
  guaranteedMilligradesOf,
  memoryRecallTarget,
  reachableMilligradesOf
} from "../../../index.js";

const DIGEST = `sha256:${"c".repeat(64)}`;
const target = memoryRecallTarget({
  workspace_id: "ws",
  object_id: "mem-1",
  source_revision: "rev-1"
});

describe("conditional-field measurement and activation", () => {
  it("rejects cosine-as-cap, NaN, and missing-as-zero for raw measurement", () => {
    expect(() => ProjectedCapSchema.parse({
      status: "projected",
      domain_id: ASSOCIATION_DOMAIN_ID,
      transfer_id: "transfer",
      transfer_version: "v1",
      milligrades: 0.87
    })).toThrow();
    expect(() => ProjectedCapSchema.parse({
      status: "projected",
      domain_id: ASSOCIATION_DOMAIN_ID,
      transfer_id: "transfer",
      transfer_version: "v1",
      milligrades: 1001
    })).toThrow();
    expect(ProjectedCapSchema.parse({
      status: "projected",
      domain_id: ASSOCIATION_DOMAIN_ID,
      transfer_id: "transfer",
      transfer_version: "v1",
      milligrades: 850
    }).status).toBe("projected");
    expect(ProjectedCapSchema.parse({ status: "inapplicable" }).status).toBe("inapplicable");
    expect(() => RawMeasurementSchema.parse({
      status: "measured",
      producer_id: "p",
      model_id: "m",
      domain: "d",
      normalization: "n",
      referent: target,
      source_revision: "rev-1",
      query_digest: DIGEST,
      raw: Number.NaN
    })).toThrow();
    expect(RawMeasurementSchema.parse({ status: "missing" }).status).toBe("missing");
    expect(RawMeasurementSchema.parse({ status: "unavailable" }).status).toBe("unavailable");
    expect(RawMeasurementSchema.parse({ status: "unsupported" }).status).toBe("unsupported");
    expect(RawMeasurementSchema.parse({
      status: "measured",
      producer_id: "p",
      model_id: "m",
      domain: "d",
      normalization: "n",
      referent: target,
      source_revision: "rev-1",
      query_digest: DIGEST,
      raw: 0
    }).status).toBe("measured");
  });

  it("keeps unreachable distinct from reachable zero", () => {
    expect(FieldActivationSchema.parse({ kind: "unreachable" })).toEqual({ kind: "unreachable" });
    expect(FieldActivationSchema.parse({ kind: "reachable", milligrades: 0 })).toEqual({
      kind: "reachable",
      milligrades: 0
    });
    expect(fieldActivationOf({ milligrades: 0 })).toEqual({ kind: "reachable", milligrades: 0 });
    expect(fieldActivationOf({ activation: { kind: "unreachable" } })).toEqual({ kind: "unreachable" });
    expect(reachableMilligradesOf({ milligrades: 0 })).toBe(0);
    expect(reachableMilligradesOf({ activation: { kind: "unreachable" } })).toBeUndefined();
  });

  it("reads guaranteed milligrades from activation.low, else low, else the index field", () => {
    expect(guaranteedMilligradesOf({ milligrades: 900 })).toBeUndefined();
    expect(guaranteedMilligradesOf({ milligrades: 0 })).toBeUndefined();
    expect(guaranteedMilligradesOf({
      milligrades: 900,
      low_milligrades: 0
    })).toBe(0);
    expect(guaranteedMilligradesOf({
      milligrades: 700,
      low_milligrades: 700
    })).toBe(700);
    expect(guaranteedMilligradesOf({
      milligrades: 900,
      activation: { kind: "reachable", milligrades: 900, low: 0 }
    })).toBe(0);
    expect(guaranteedMilligradesOf({
      activation: { kind: "reachable", milligrades: 900 },
      low_milligrades: 600
    })).toBe(600);
    expect(guaranteedMilligradesOf({ guaranteed_milligrades: 700 })).toBe(700);
    expect(guaranteedMilligradesOf({
      activation: { kind: "unreachable" }
    })).toBeUndefined();
  });
});
