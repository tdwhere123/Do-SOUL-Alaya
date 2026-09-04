export type QueryClassCapabilityId =
  | "scalar_simple"
  | "distinct"
  | "sequence"
  | "extremum"
  | "required_proposition"
  | "certified_independent_support";

export type QueryClassSourceEvidenceV1 = Readonly<{
  readonly owner: string | null;
  readonly available: boolean;
}>;

export interface QueryClassCapabilityStatus {
  readonly capability: QueryClassCapabilityId;
  readonly source_owner: string | null;
  readonly source_available: boolean;
  readonly supported_in_shadow: boolean;
  readonly unsupported_reason?: string;
}

const CLASS_OWNERS: Readonly<Record<QueryClassCapabilityId, string | null>> = Object.freeze({
  scalar_simple: "osf",
  required_proposition: "support",
  certified_independent_support: "support",
  distinct: null,
  sequence: null,
  extremum: null
});

const CLASS_UNSUPPORTED_REASON: Readonly<Record<QueryClassCapabilityId, string>> = Object.freeze({
  scalar_simple: "scalar_simple_source_unproved",
  required_proposition: "required_proposition_source_unproved",
  certified_independent_support: "certified_independent_source_unproved",
  distinct: "distinctness_source_unsupported",
  sequence: "sequence_slots_source_unsupported",
  extremum: "extremum_witness_source_unsupported"
});

export function queryClassCapabilityStatus(
  capability: QueryClassCapabilityId,
  source?: QueryClassSourceEvidenceV1
): QueryClassCapabilityStatus {
  const expectedOwner = CLASS_OWNERS[capability];
  if (expectedOwner === null) {
    return Object.freeze({
      capability,
      source_owner: source?.owner ?? null,
      source_available: false,
      supported_in_shadow: false,
      unsupported_reason: CLASS_UNSUPPORTED_REASON[capability]
    });
  }
  const owner = source?.owner ?? expectedOwner;
  // No-arg is unproved: available must be evidenced, not assumed from class id.
  const available = source?.available === true && owner === expectedOwner;
  if (!available) {
    return Object.freeze({
      capability,
      source_owner: source === undefined ? null : owner,
      source_available: false,
      supported_in_shadow: false,
      unsupported_reason: CLASS_UNSUPPORTED_REASON[capability]
    });
  }
  return Object.freeze({
    capability,
    source_owner: owner,
    source_available: true,
    supported_in_shadow: true
  });
}

export function answerProgramCapabilityId(
  kind: "scalar" | "distinct" | "sequence" | "argmax" | "argmin"
): QueryClassCapabilityId {
  if (kind === "scalar") return "scalar_simple";
  if (kind === "distinct") return "distinct";
  if (kind === "sequence") return "sequence";
  return "extremum";
}
