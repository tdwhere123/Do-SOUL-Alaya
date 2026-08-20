import { describe, expect, it } from "vitest";

import {
  assertFineAssessmentOrderLedgerAttribution,
  type FineAssessmentMembershipOwner,
  type FineAssessmentOrderLedger
} from "../../recall/delivery/fine-assessment-selection/order-ledger.js";

const ATTRIBUTION_ERROR =
  /selection order ledger has multiple simultaneous membership-changing owners/u;

describe("order ledger attribution", () => {
  it("accepts Select_Gamma as the sole membership owner", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("select_gamma", ["select_gamma"])
    )).not.toThrow();
  });

  it("accepts unavailable coarse identity without inventing an owner", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("unavailable", ["unavailable"])
    )).not.toThrow();
  });

  it("refuses a candidate whose first membership owner cannot be named", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger(null, ["select_gamma"])
    )).toThrow(ATTRIBUTION_ERROR);
  });

  it("refuses a first owner that does not match the receipt", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("unavailable", ["select_gamma"])
    )).toThrow(ATTRIBUTION_ERROR);
  });

  it("refuses duplicate Select_Gamma owners", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("select_gamma", ["select_gamma", "select_gamma"])
    )).toThrow(ATTRIBUTION_ERROR);
  });

  it("refuses a non-null first owner when the owner list is empty", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("select_gamma", [])
    )).toThrow(/selection order ledger membership owner identity mismatch/u);
  });

  it("refuses a legacy membership owner at runtime", () => {
    const invalid = attributionLedger("select_gamma", ["select_gamma"]);
    const candidate = invalid.candidates[0]!;
    const legacy = {
      ...invalid,
      candidates: [{
        ...candidate,
        first_membership_changing_owner: "coverage",
        membership_changing_owners: ["coverage"]
      }]
    } as unknown as FineAssessmentOrderLedger;

    expect(() => assertFineAssessmentOrderLedgerAttribution(legacy))
      .toThrow(ATTRIBUTION_ERROR);
  });
});

function attributionLedger(
  first: FineAssessmentMembershipOwner | null,
  owners: readonly FineAssessmentMembershipOwner[]
): FineAssessmentOrderLedger {
  return {
    schema_version: 2,
    candidate_count: 1,
    delivered_count: 1,
    coarse_identity: "captured",
    candidates: [{
      candidate_key: "candidate",
      ranks: {
        coarse: 1,
        fusion: 1,
        deep_head: 1,
        select_gamma: 1,
        final: 1
      },
      first_membership_changing_owner: first,
      membership_changing_owners: owners
    }]
  };
}
