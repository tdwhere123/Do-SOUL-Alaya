import {
  freezeShadow,
  requireNonemptyString,
  ShadowContractError
} from "../../../prefix-capture/envelope.js";
import type {
  WitnessIdentityPins
} from "./types.js";

const OPTIONAL_PINS = [
  "observer_id",
  "candidate_id",
  "universe_digest",
  "proposition_id"
] as const;

type OptionalIdentityPin = (typeof OPTIONAL_PINS)[number];

export function parseIdentityPins(
  input: WitnessIdentityPins,
  requiredExtra: readonly OptionalIdentityPin[] = []
): WitnessIdentityPins {
  const pins: Record<string, string> = {
    coordinate_id: requireNonemptyString(input.coordinate_id, "coordinate_id"),
    query_id: requireNonemptyString(input.query_id, "query_id"),
    snapshot_digest: requireNonemptyString(input.snapshot_digest, "snapshot_digest")
  };
  for (const key of requiredExtra) {
    pins[key] = requireNonemptyString(input[key], key);
  }
  for (const key of OPTIONAL_PINS) {
    if (requiredExtra.includes(key)) continue;
    const value = input[key];
    if (value !== undefined) pins[key] = requireNonemptyString(value, key);
  }
  return freezeShadow(pins) as WitnessIdentityPins;
}

export function identitiesEqual(
  left: WitnessIdentityPins,
  right: WitnessIdentityPins
): boolean {
  return identityKey(left) === identityKey(right);
}

export function assertIdentityPreserved(
  from: WitnessIdentityPins,
  to: WitnessIdentityPins
): void {
  if (!identitiesEqual(from, to)) {
    throw new ShadowContractError("identity pin change is illegal refinement");
  }
}

export function identityKey(pins: WitnessIdentityPins): string {
  return [
    pins.coordinate_id,
    pins.query_id,
    pins.snapshot_digest,
    pinOrEmpty(pins.observer_id),
    pinOrEmpty(pins.candidate_id),
    pinOrEmpty(pins.universe_digest),
    pinOrEmpty(pins.proposition_id)
  ].join("\0");
}

export function freezeIdentity(pins: WitnessIdentityPins): WitnessIdentityPins {
  return parseIdentityPins(pins, presentOptionalPins(pins));
}

function presentOptionalPins(
  pins: WitnessIdentityPins
): readonly OptionalIdentityPin[] {
  return OPTIONAL_PINS.filter((key) => pins[key] !== undefined);
}

function pinOrEmpty(value: string | undefined): string {
  return value ?? "";
}
