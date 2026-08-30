import {
  type ShadowEnvelope,
  type ShadowObservedEnvelope
} from "../envelope.js";
import { ShadowContractError } from "../../contract-primitives.js";
import {
  createNumericIntervalWitness,
  type NumericIntervalWitness
} from "./domains/numeric.js";
import type { WitnessIdentityPins, WitnessProvenanceEntry } from
  "./shared/types.js";

export type EnvelopeWitnessFrame = Readonly<{
  readonly identity: WitnessIdentityPins;
  readonly provenance: readonly WitnessProvenanceEntry[];
}>;

export function witnessFromShadowEnvelope(
  envelope: ShadowEnvelope,
  frame: EnvelopeWitnessFrame
): NumericIntervalWitness {
  if (envelope.state === "observed") return mapObserved(envelope, frame);
  if (envelope.state === "observed_negative") {
    return numericFrame(frame, { kind: "negative", named_negative: envelope.named_consumer });
  }
  if (envelope.state === "required_but_missing") {
    return numericFrame(frame, { kind: "not_observed" });
  }
  if (envelope.state === "not_applicable") {
    return numericFrame(frame, { kind: "not_applicable" });
  }
  if (envelope.state === "producer_unavailable") {
    return numericFrame(frame, { kind: "unavailable" });
  }
  if (envelope.state === "not_observed") {
    return numericFrame(frame, { kind: "not_observed" });
  }
  throw new ShadowContractError("unknown envelope state");
}

function mapObserved(
  envelope: ShadowObservedEnvelope,
  frame: EnvelopeWitnessFrame
): NumericIntervalWitness {
  const value = envelope.value;
  return createNumericIntervalWitness({
    identity: frame.identity,
    provenance: frame.provenance,
    epistemic: { kind: "exact" },
    payload: { lower: value, upper: value }
  });
}

function numericFrame(
  frame: EnvelopeWitnessFrame,
  epistemic: NumericIntervalWitness["epistemic"]
): NumericIntervalWitness {
  return createNumericIntervalWitness({
    identity: frame.identity,
    provenance: frame.provenance,
    epistemic,
    payload: null
  });
}
