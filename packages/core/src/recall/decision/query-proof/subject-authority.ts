import {
  parseShadowEnvelope,
  type ShadowEnvelope
} from "./envelope.js";
import {
  assertAllowedKeys,
  freezeShadow,
  requireNonemptyString,
  requireShadowRecord,
  ShadowContractError
} from "../contract-primitives.js";
import type {
  ShadowSubjectComponent,
  ShadowSubjectComponentId
} from "./observations.js";

export const SUBJECT_COMPONENT_IDS: ReadonlySet<string> = new Set([
  "preference", "self_reference"
]);

export function parseSubjectComponent(input: unknown): ShadowSubjectComponent {
  const record = requireShadowRecord(input, "subject component");
  assertAllowedKeys(record, ["component_id", "operator_id", "authority_state", "envelope"]);
  if (typeof record.component_id !== "string" ||
      !SUBJECT_COMPONENT_IDS.has(record.component_id)) {
    throw new ShadowContractError("invalid subject component");
  }
  const authorityState = parseSubjectAuthorityState(record.authority_state);
  const envelope = parseShadowEnvelope(record.envelope);
  if (!subjectAuthorityMatchesEnvelope(authorityState, envelope)) {
    throw new ShadowContractError("subject component authority state mismatch");
  }
  return freezeShadow({
    component_id: record.component_id as ShadowSubjectComponentId,
    operator_id: requireNonemptyString(record.operator_id, "operator_id"),
    authority_state: authorityState,
    envelope
  });
}

export function subjectAuthorityMatchesEnvelope(
  state: ShadowSubjectComponent["authority_state"],
  envelope: ShadowEnvelope
): boolean {
  if (state === "evaluated") {
    return envelope.state === "observed" || envelope.state === "observed_negative";
  }
  if (state === "not_applicable") return envelope.state === "not_applicable";
  return envelope.state === "not_observed";
}

export function parseSubjectAuthorityState(
  value: unknown
): ShadowSubjectComponent["authority_state"] {
  if (typeof value === "string" && [
    "not_applicable", "disabled", "untrusted", "not_run", "evaluated"
  ].includes(value)) return value as ShadowSubjectComponent["authority_state"];
  throw new ShadowContractError("invalid subject component authority state");
}
