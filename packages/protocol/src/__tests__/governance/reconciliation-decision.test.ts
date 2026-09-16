import { describe, expect, it } from "vitest";
import {
  QueryAvailability,
  QueryAvailabilitySchema,
  ReconciliationDecisionKind,
  ReconciliationDecisionKindSchema,
  ReconciliationDeferral,
  ReconciliationDeferralSchema
} from "../../index.js";

describe("reconciliation write-path availability", () => {
  it("keeps successful empty distinct from unavailable", () => {
    expect(QueryAvailabilitySchema.parse(QueryAvailability.OK)).toBe("ok");
    expect(QueryAvailabilitySchema.parse(QueryAvailability.UNAVAILABLE)).toBe("unavailable");
    expect(QueryAvailability.OK).not.toBe(QueryAvailability.UNAVAILABLE);
  });

  it("treats deferred as a first-class verdict, not an add", () => {
    expect(ReconciliationDecisionKindSchema.parse(ReconciliationDecisionKind.DEFERRED)).toBe(
      "deferred"
    );
    expect(ReconciliationDeferralSchema.parse(ReconciliationDeferral.PREWRITE_UNAVAILABLE)).toBe(
      "prewrite_unavailable"
    );
    expect(ReconciliationDeferralSchema.parse(ReconciliationDeferral.LEASE_BUSY)).toBe("lease_busy");
  });
});
