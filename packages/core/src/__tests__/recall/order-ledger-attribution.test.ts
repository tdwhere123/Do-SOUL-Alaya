import { describe, expect, it } from "vitest";

import {
  assertFineAssessmentOrderLedgerAttribution,
  type FineAssessmentMembershipOwner,
  type FineAssessmentOrderLedger
} from "../../recall/delivery/fine-assessment-selection/order-ledger.js";

const SIMULTANEOUS =
  /selection order ledger has multiple simultaneous membership-changing owners/u;

describe("order ledger attribution", () => {
  it("accepts sequential membership flips with a unique first owner", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("fusion", ["fusion", "deep_head", "consensus"])
    )).not.toThrow();
  });

  it("refuses a candidate whose first membership owner cannot be named", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger(null, ["fusion", "deep_head"])
    )).toThrow(SIMULTANEOUS);
  });

  it("refuses a first-owner tie against the sequential owner list", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("deep_head", ["fusion", "deep_head"])
    )).toThrow(SIMULTANEOUS);
  });

  it("refuses duplicate owners that collapse two flips into one phase", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("fusion", ["fusion", "fusion"])
    )).toThrow(SIMULTANEOUS);
  });

  it("refuses a non-null first owner when the owner list is empty", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("fusion", [])
    )).toThrow(/selection order ledger membership owner identity mismatch/u);
  });

  it("refuses a first owner that is not in the owner list", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("coverage", ["fusion", "deep_head"])
    )).toThrow(/first owner is not owners\[0\]/u);
  });

  it("refuses owners listed out of canonical stage order", () => {
    expect(() => assertFineAssessmentOrderLedgerAttribution(
      attributionLedger("deep_head", ["deep_head", "fusion"])
    )).toThrow(/non-canonical stage order/u);
  });
});

function attributionLedger(
  first: FineAssessmentMembershipOwner | null,
  owners: readonly FineAssessmentMembershipOwner[]
): FineAssessmentOrderLedger {
  return {
    schema_version: 1,
    candidate_count: 1,
    delivered_count: 1,
    coarse_identity: "captured",
    candidates: [{
      candidate_key: "candidate",
      ranks: {
        coarse: 1,
        fusion: 1,
        deep_head: 1,
        coverage: 1,
        consensus: 1,
        final: 1
      },
      first_membership_changing_owner: first,
      membership_changing_owners: owners
    }]
  };
}
