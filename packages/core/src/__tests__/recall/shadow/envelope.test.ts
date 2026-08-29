import { describe, expect, it } from "vitest";
import {
  isObservedZero,
  parseShadowEnvelope,
  ShadowContractError
} from "../../../recall/shadow/index.js";
import {
  isKnownZeroEpistemic,
  witnessFromShadowEnvelope
} from "../../../recall/shadow/witness/index.js";

const COMPLETE_WITNESSES = {
  query_requires: true,
  applicable: true,
  producer_available: true,
  candidate_evaluated: true,
  completeness_owner: "named.completeness.owner.v1",
  evaluation_exhausted: true,
  proven_absence: true
} as const;

describe("shadow envelope", () => {
  it("treats observed zero as weak evidence, not missing", () => {
    const observedZero = parseShadowEnvelope({ state: "observed", value: 0 });
    const missing = parseShadowEnvelope({ state: "not_observed", reason: "missing_rank" });
    const unavailable = parseShadowEnvelope({ state: "producer_unavailable" });
    const notApplicable = parseShadowEnvelope({ state: "not_applicable" });

    expect(isObservedZero(observedZero)).toBe(true);
    expect(isObservedZero(missing)).toBe(false);
    expect(isObservedZero(unavailable)).toBe(false);
    expect(isObservedZero(notApplicable)).toBe(false);
    expect(observedZero).not.toEqual(missing);
    expect(observedZero).not.toEqual(unavailable);
    expect(observedZero).not.toEqual(notApplicable);
  });

  it("rejects ambiguous or impossible state payloads", () => {
    const cases: unknown[] = [
      { state: "observed" },
      { state: "observed", value: Number.NaN },
      { state: "observed", value: 0, missing: true },
      { state: "not_observed", value: 0 },
      { state: "not_applicable", value: 0 },
      { state: "producer_unavailable", value: 0.5 },
      { state: "observed_negative" },
      { state: "observed_negative", named_consumer: "truncation" },
      { state: "observed_negative", named_consumer: "no_path_under_cap" },
      { state: "mystery" }
    ];

    for (const payload of cases) {
      expect(() => parseShadowEnvelope(payload)).toThrow(ShadowContractError);
    }
  });

  it("rejects required_but_missing without evaluation and completeness witnesses", () => {
    expect(() => parseShadowEnvelope({
      state: "required_but_missing"
    })).toThrow(/witness/u);
    expect(() => parseShadowEnvelope({
      state: "required_but_missing",
      witnesses: { ...COMPLETE_WITNESSES, candidate_evaluated: false }
    })).toThrow(/candidate_evaluated/u);
    expect(() => parseShadowEnvelope({
      state: "required_but_missing",
      witnesses: { ...COMPLETE_WITNESSES, completeness_owner: "" }
    })).toThrow(/completeness/u);
    expect(() => parseShadowEnvelope({
      state: "required_but_missing",
      witnesses: { ...COMPLETE_WITNESSES, completeness_owner: "truncated" }
    })).toThrow(/truncation/u);
    expect(parseShadowEnvelope({
      state: "required_but_missing",
      witnesses: COMPLETE_WITNESSES
    }).state).toBe("required_but_missing");
  });

  it("adapts parsed envelopes onto typed epistemics without changing parse", () => {
    const frame = {
      identity: {
        coordinate_id: "coord.envelope",
        query_id: "query-1",
        snapshot_digest: `sha256:${"a".repeat(64)}`,
        candidate_id: "cand-1"
      },
      provenance: [{ source_id: "src-1", producer: "producer.alpha" }]
    };
    const observedZero = parseShadowEnvelope({ state: "observed", value: 0 });
    const adaptedZero = witnessFromShadowEnvelope(observedZero, frame);
    expect(isObservedZero(observedZero)).toBe(true);
    expect(isKnownZeroEpistemic(adaptedZero.epistemic)).toBe(false);
    expect(adaptedZero.payload).toEqual({ lower: 0, upper: 0 });

    const missing = witnessFromShadowEnvelope(
      parseShadowEnvelope({
        state: "required_but_missing",
        witnesses: COMPLETE_WITNESSES
      }),
      frame
    );
    expect(isKnownZeroEpistemic(missing.epistemic)).toBe(true);
    expect(missing.payload).toBeNull();
    expect(witnessFromShadowEnvelope(
      parseShadowEnvelope({ state: "producer_unavailable" }),
      frame
    ).epistemic.kind).toBe("unavailable");
    expect(witnessFromShadowEnvelope(
      parseShadowEnvelope({ state: "not_observed" }),
      frame
    ).epistemic.kind).toBe("not_observed");
    expect(witnessFromShadowEnvelope(
      parseShadowEnvelope({ state: "not_applicable" }),
      frame
    ).epistemic.kind).toBe("not_applicable");
  });
});
