import { describe, expect, it } from "vitest";
import {
  compareChannelEnvelopes,
  compareEnvelopeStates,
  parseShadowEnvelope,
  SHADOW_ENVELOPE_STATES,
  SHADOW_STATE_PAIR_MATRIX,
  type ShadowEnvelopeState,
  type ShadowStatePairKind
} from "../../../recall/shadow/index.js";

function plantedKind(
  left: ShadowEnvelopeState,
  right: ShadowEnvelopeState
): ShadowStatePairKind {
  if (left === "observed_negative" || left === "required_but_missing" ||
      right === "observed_negative" || right === "required_but_missing") {
    return "contract_failure";
  }
  if (left === "observed" && right === "observed") return "numeric";
  if (left === right &&
      (left === "not_applicable" || left === "producer_unavailable" ||
        left === "not_observed")) {
    return "skip";
  }
  return "incomparable";
}

const PAIRS = SHADOW_ENVELOPE_STATES.flatMap((left) =>
  SHADOW_ENVELOPE_STATES.map((right) => ({ left, right }))
);

describe("six-state pair matrix", () => {
  it.each(PAIRS)("plants $left vs $right", ({ left, right }) => {
    const expected = plantedKind(left, right);
    expect(SHADOW_STATE_PAIR_MATRIX[left][right]).toBe(expected);
    expect(compareEnvelopeStates(left, right).kind).toBe(expected);
  });

  it("treats embedding domain mismatch as incomparable, not skip", () => {
    const observed = parseShadowEnvelope({ state: "observed", value: 0.2 });
    expect(compareChannelEnvelopes(observed, observed, false).kind).toBe("incomparable");
    expect(compareChannelEnvelopes(observed, observed, true).kind).toBe("numeric");
  });

  it("does not skip mixed unknown states", () => {
    expect(compareEnvelopeStates("not_applicable", "not_observed").kind)
      .toBe("incomparable");
    expect(compareEnvelopeStates("producer_unavailable", "not_observed").kind)
      .toBe("incomparable");
    expect(compareEnvelopeStates("observed", "not_observed").kind).toBe("incomparable");
  });
});
