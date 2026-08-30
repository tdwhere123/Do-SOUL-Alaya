import { describe, expect, it } from "vitest";
import {
  parseShadowEnvelope,
  type ShadowEnvelope
} from "../../../../recall/shadow/envelope.js";
import {
  consumerView,
  isKnownZeroEpistemic,
  witnessFromShadowEnvelope
} from "../../../../recall/shadow/witness/index.js";
import { PINS, PROV } from "./fixtures.js";

const COMPLETE_WITNESSES = {
  query_requires: true,
  applicable: true,
  producer_available: true,
  candidate_evaluated: true,
  completeness_owner: "named.completeness.owner.v1",
  evaluation_exhausted: true,
  proven_absence: true
} as const;

function map(envelope: ShadowEnvelope) {
  return witnessFromShadowEnvelope(envelope, {
    identity: PINS,
    provenance: PROV
  });
}

describe("shadow envelope adapter", () => {
  it("maps observed zero to plain exact zero", () => {
    const observedZero = map(parseShadowEnvelope({ state: "observed", value: 0 }));
    expect(observedZero.epistemic.kind).toBe("exact");
    expect(isKnownZeroEpistemic(observedZero.epistemic)).toBe(false);
    expect(observedZero.payload).toEqual({ lower: 0, upper: 0 });

  });

  it("maps observed nonzero to a degenerate exact interval", () => {
    const observed = map(parseShadowEnvelope({ state: "observed", value: 4 }));
    expect(observed.epistemic.kind).toBe("exact");
    expect(observed.payload).toEqual({ lower: 4, upper: 4 });
  });

  it("maps remaining envelope states without minting exact absence", () => {
    const negative = map(parseShadowEnvelope({
      state: "observed_negative",
      named_consumer: "h_temporal"
    }));
    const absenceEnvelope = parseShadowEnvelope({
      state: "required_but_missing",
      witnesses: COMPLETE_WITNESSES
    });
    const absence = map(absenceEnvelope);
    const notApplicable = map(parseShadowEnvelope({ state: "not_applicable" }));
    const unavailable = map(parseShadowEnvelope({ state: "producer_unavailable" }));
    const notObserved = map(parseShadowEnvelope({
      state: "not_observed",
      reason: "not_run"
    }));
    const exactZero = map(parseShadowEnvelope({ state: "observed", value: 0 }));

    expect(negative.epistemic.kind).toBe("negative");
    expect(negative.epistemic.kind === "negative" && negative.epistemic.named_negative)
      .toBe("h_temporal");
    expect(isKnownZeroEpistemic(absence.epistemic)).toBe(false);
    expect(absence.epistemic.kind).toBe("not_observed");
    expect(absence.payload).toBeNull();
    expect(notApplicable.epistemic.kind).toBe("not_applicable");
    expect(unavailable.epistemic.kind).toBe("unavailable");
    expect(notObserved.epistemic.kind).toBe("not_observed");
    expect(consumerView(absence)).toEqual(consumerView(notObserved));

    const views = [
      exactZero, negative, notApplicable, unavailable, notObserved
    ].map((witness) => JSON.stringify(consumerView(witness)));
    expect(new Set(views).size).toBe(views.length);
    expect(JSON.stringify(absence)).not.toContain("\"value\":0");
  });
});
