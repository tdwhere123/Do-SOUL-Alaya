import type { D1EnvelopeIdentity, D1EnvelopeValue } from "../d1/legal-envelope.js";
import {
  collapseMeasurementGroup,
  createMeasurementGroupContractV1,
  type MeasurementCollapseV1
} from "../measurement/index.js";
import {
  createNumericIntervalWitness,
  type WitnessIdentityPins,
  type WitnessProvenanceEntry
} from "../witness/index.js";

export const LEXICAL_INTERVAL_MEASUREMENT_CONTRACT = createMeasurementGroupContractV1({
  contract_id: "measure.lexical.interval.v1",
  operator_version: "1",
  proposition_schema: "lex.interval",
  measurement_domain: "numeric_interval",
  comparison_direction: "higher_is_stronger",
  correlation_policy: "identity_dedupe",
  combine_operator: "bound_intersection",
  soundness_preconditions: ["receipt_backed_interval", "lex_domain_frozen"],
  upper_bound_rule: "interval_upper"
});

export function adaptLexicalIntervalEnvelopeToCollapse(
  value: D1EnvelopeValue,
  identity: WitnessIdentityPins,
  provenance: readonly WitnessProvenanceEntry[],
  envelopeIdentity: D1EnvelopeIdentity | null
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
  if (envelopeIdentity.query_run_id !== identity.query_id) {
    return unresolved("lexical envelope query identity does not match the observation pin");
  }
  if (envelopeIdentity.snapshot_digest !== identity.snapshot_digest) {
    return unresolved("lexical envelope snapshot identity does not match the observation pin");
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
