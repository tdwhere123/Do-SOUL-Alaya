import { describe, expect, it } from "vitest";
import {
  parseShadowEnvelope,
  type ShadowEnvelope
} from "../../../../recall/shadow/envelope.js";
import {
  consumerView,
  isKnownZeroEpistemic,
  serializeWitness,
  witnessFromShadowEnvelope
} from "../../../../recall/shadow/witness/index.js";
import { COMPLETE, PINS, PROV } from "./fixtures.js";

const COMPLETE_WITNESSES = {
  query_requires: true,
  applicable: true,
  producer_available: true,
  candidate_evaluated: true,
  completeness_owner: "named.completeness.owner.v1",
  evaluation_exhausted: true,
  proven_absence: true
} as const;

function map(envelope: ShadowEnvelope, completeness?: { owner: string }) {
  return witnessFromShadowEnvelope(envelope, {
    identity: PINS,
    provenance: PROV,
    completeness
  });
}

describe("shadow envelope adapter", () => {
  it("maps observed zero to exact zero unless the caller supplies completeness", () => {
    const observedZero = map(parseShadowEnvelope({ state: "observed", value: 0 }));
    expect(observedZero.epistemic.kind).toBe("exact");
    expect(isKnownZeroEpistemic(observedZero.epistemic)).toBe(false);
    expect(observedZero.payload).toEqual({ lower: 0, upper: 0 });

    const knownZero = map(parseShadowEnvelope({ state: "observed", value: 0 }), COMPLETE);
    expect(isKnownZeroEpistemic(knownZero.epistemic)).toBe(true);
    expect(knownZero.payload).toEqual({ lower: 0, upper: 0 });
    expect(serializeWitness(observedZero)).not.toBe(serializeWitness(knownZero));
  });

  it("maps observed nonzero to a degenerate exact interval", () => {
    const observed = map(parseShadowEnvelope({ state: "observed", value: 4 }));
    expect(observed.epistemic.kind).toBe("exact");
    expect(observed.payload).toEqual({ lower: 4, upper: 4 });
    expect(() => map(parseShadowEnvelope({ state: "observed", value: 4 }), COMPLETE))
      .toThrow(/completeness/u);
  });

  it("maps remaining envelope states onto distinct epistemics", () => {
    const negative = map(parseShadowEnvelope({
      state: "observed_negative",
      named_consumer: "h_temporal"
    }));
    const absence = map(parseShadowEnvelope({
      state: "required_but_missing",
      witnesses: COMPLETE_WITNESSES
    }));
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
    expect(isKnownZeroEpistemic(absence.epistemic)).toBe(true);
    expect(absence.payload).toBeNull();
    expect(notApplicable.epistemic.kind).toBe("not_applicable");
    expect(unavailable.epistemic.kind).toBe("unavailable");
    expect(notObserved.epistemic.kind).toBe("not_observed");

    const views = [
      exactZero, negative, absence, notApplicable, unavailable, notObserved
    ].map((witness) => JSON.stringify(consumerView(witness)));
    expect(new Set(views).size).toBe(views.length);
    expect(JSON.stringify(absence)).not.toContain("\"value\":0");
  });
});
