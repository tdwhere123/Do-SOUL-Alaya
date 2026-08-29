import type { D1EnvelopeIdentity, D1EnvelopeValue } from "../d1/legal-envelope.js";
import {
  collapseMeasurementGroup,
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  type MeasurementCollapseV1,
  type VerifiedMeasurementAuthorityV1
} from "../measurement/index.js";
import {
  createNumericIntervalWitness,
  type WitnessIdentityPins,
  type WitnessProvenanceEntry
} from "../witness/index.js";

export function adaptLexicalIntervalEnvelopeToCollapse(
  value: D1EnvelopeValue,
  identity: WitnessIdentityPins,
  provenance: readonly WitnessProvenanceEntry[],
  envelopeIdentity: D1EnvelopeIdentity | null,
  preparedAuthority: VerifiedMeasurementAuthorityV1
): MeasurementCollapseV1 {
  if (value.kind !== "interval") {
    return unresolved(value.kind === "unbounded"
      ? "unbounded lexical-bound proof remains unresolved"
      : "inapplicable lexical envelope is not a bound");
  }
  if (value.lower > value.upper) {
    return unresolved("inverted lexical interval remains unresolved");
  }
  if (envelopeIdentity === null) {
    return unresolved("forged lexical interval without legal envelope identity remains unresolved");
  }
  if (identity.query_id !== preparedAuthority.query_id ||
    identity.snapshot_digest !== preparedAuthority.snapshot_digest) {
    return unresolved("prepared query identity does not match the observation pin");
  }
  if (envelopeIdentity.snapshot_digest !== preparedAuthority.snapshot_digest ||
    envelopeIdentity.request_digest !== preparedAuthority.request_digest ||
    envelopeIdentity.workspace_id !== preparedAuthority.workspace_id ||
    envelopeIdentity.field_prefix !== preparedAuthority.field_prefix) {
    return unresolved("lexical envelope does not match the prepared request identity");
  }
  return collapseMeasurementGroup({
    contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
    observations: [
      createNumericIntervalWitness({
        identity,
        provenance,
        epistemic: { kind: "exact" },
        payload: { lower: value.lower, upper: value.upper }
      })
    ]
  });
}

function unresolved(reason: string): MeasurementCollapseV1 {
  return { status: "unresolved", reason, observations: [] };
}
