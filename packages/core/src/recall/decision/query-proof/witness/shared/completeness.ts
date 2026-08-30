import {
  assertAllowedKeys,
  isShadowRecord,
  ShadowContractError
} from "../../../contract-primitives.js";
import type {
  WitnessCompleteness,
  WitnessDomainKind,
  WitnessIdentityPins
} from "./types.js";

const ISSUED_COMPLETENESS = new WeakSet<object>();

export function parseCompleteness(value: unknown): WitnessCompleteness {
  if (!isShadowRecord(value) || !ISSUED_COMPLETENESS.has(value)) {
    throw new ShadowContractError(
      "known_zero rejected without issued completeness authority"
    );
  }
  assertAllowedKeys(value, [
    "schema_version", "receipt_id", "authority_id", "authority_digest", "owner",
    "observer_id", "coordinate_id", "query_id", "snapshot_digest", "candidate_id",
    "universe_digest", "domain", "receipt_digest"
  ]);
  return value as WitnessCompleteness;
}

export function assertCompletenessApplies(
  completeness: WitnessCompleteness,
  domain: WitnessDomainKind,
  identity: WitnessIdentityPins
): void {
  const receipt = parseCompleteness(completeness);
  if (receipt.domain !== domain || receipt.observer_id !== identity.observer_id ||
    receipt.coordinate_id !== identity.coordinate_id || receipt.query_id !== identity.query_id ||
    receipt.snapshot_digest !== identity.snapshot_digest ||
    receipt.candidate_id !== identity.candidate_id ||
    receipt.universe_digest !== identity.universe_digest) {
    throw new ShadowContractError("completeness witness binding mismatch");
  }
}
