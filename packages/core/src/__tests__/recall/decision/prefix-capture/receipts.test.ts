import { describe, expect, it } from "vitest";
import type { SelectGammaRequest } from
  "../../../../recall/delivery/select-gamma/types.js";
import {
  assertShadowReceiptHasNoDeliveryOrder,
  type ShadowHasDeliveryOrderField
} from "../../../../recall/decision/contract-primitives.js";
import {
  parseCaptureDecisionReceipt,
  parseCoreKnownNoWitness,
  parseEqualGReject
} from "../../../../recall/decision/prefix-capture/receipts.js";
import {
  parseSetUtilityInput,
  type ShadowSetUtilityInput
} from "../../../../recall/decision/prefix-capture/capture.js";

function acceptSelectGamma(_request: SelectGammaRequest): void {}

function utility(): ShadowSetUtilityInput {
  return parseSetUtilityInput({
    schema_version: 1,
    candidate_key: "cand-a",
    object_key: "obj-a",
    obligations: [],
    matches: [],
    values: { status: "unavailable", values: [] },
    cid: { status: "unavailable" },
    availability: {
      facility: "not_applicable",
      values: "unavailable",
      evidence_identity: "unavailable"
    }
  });
}

describe("prefix-capture receipts", () => {
  it("records max-G rejects and the deterministic tail without delivery order", () => {
    expect(parseEqualGReject({
      candidate_key: "b",
      dominated_by: "a"
    }).dominated_by).toBe("a");
    const decision = parseCaptureDecisionReceipt({
      schema_version: 1,
      candidate_key: "a",
      capture_reason: "core_undominated",
      G: { unscaled_remainder: 0, Values_v: 0, evidence_novelty_redundancy: 0 },
      G_status: {
        facility: "not_applicable",
        values: "unavailable",
        evidence_identity: "unavailable"
      },
      named_novelty: { facility_keys: [], value_pairs: [], content_ids: [] },
      novelty_core_known_absence: [],
      max_g_cohort: ["a", "b"],
      equal_g_dominance_rejects: [{ candidate_key: "b", dominated_by: "a" }],
      deterministic_tail: "origin_plane_object_id_code_unit_ascending",
      unresolved_pointwise_tradeoff: false,
      h_gate: "none",
      walk_reject: "none",
      static_frontier_index: 1
    });
    expect(decision.max_g_cohort).toEqual(["a", "b"]);
    expect(decision.deterministic_tail).toBe("origin_plane_object_id_code_unit_ascending");
    expect("selection_order" in decision).toBe(false);
  });

  it("rejects Core unavailable as a known-no-witness exclusivity proof", () => {
    expect(() => parseCoreKnownNoWitness({
      witness: "facility",
      core_candidate_key: "core-a",
      status: "unavailable",
      basis: "cover=0"
    })).toThrow(/cannot prove exclusivity/u);
    expect(parseCoreKnownNoWitness({
      witness: "values",
      core_candidate_key: "core-a",
      status: "available_known_absent",
      basis: "composed without pair"
    }).status).toBe("available_known_absent");
  });

  it("cannot feed prefix-capture receipts into selectGammaWalk", () => {
    const receipt = utility();
    const noDelivery: [ShadowHasDeliveryOrderField<ShadowSetUtilityInput>] extends [never]
      ? true
      : false = true;
    expect(noDelivery).toBe(true);
    assertShadowReceiptHasNoDeliveryOrder(receipt);
    expect(() => assertShadowReceiptHasNoDeliveryOrder({
      ...receipt,
      ordering_basis: "forbidden"
    })).toThrow(/delivery-order field ordering_basis/u);
    // @ts-expect-error shadow set-utility is not a Select_Gamma request
    acceptSelectGamma(receipt);
  });
});
