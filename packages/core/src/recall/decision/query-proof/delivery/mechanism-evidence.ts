export const QUERY_PROOF_MECHANISM_EVIDENCE_OPERATOR_ID =
  "query_proof_mechanism_evidence_v1" as const;

export const MECHANISM_EVIDENCE_CLASSES = Object.freeze([
  "mechanism",
  "fixed_artifact_counterfactual",
  "not_replayable"
] as const);

export type MechanismEvidenceClassV1 = (typeof MECHANISM_EVIDENCE_CLASSES)[number];

export const MECHANISM_EVIDENCE_KINDS = Object.freeze([
  "planted_contract",
  "frozen_counterfactual",
  "live_provider_cache",
  "production_clock_a",
  "dataset_kpi",
  "unavailable_snapshot_source"
] as const);

export type MechanismEvidenceKindV1 = (typeof MECHANISM_EVIDENCE_KINDS)[number];

export type MechanismEvidenceClassificationV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof QUERY_PROOF_MECHANISM_EVIDENCE_OPERATOR_ID;
  readonly kind: MechanismEvidenceKindV1;
  readonly evidence_class: MechanismEvidenceClassV1;
  readonly reason: string;
}>;

export function classifyMechanismEvidence(
  input: Readonly<{
    readonly kind: MechanismEvidenceKindV1;
    readonly artifact_coordinate?: string | null;
    readonly identities_match?: boolean;
  }>
): MechanismEvidenceClassificationV1 {
  const coordinate = input.artifact_coordinate?.trim() ?? "";
  if (coordinate.length === 0) {
    return classify(input.kind, "not_replayable", "missing_artifact_coordinate");
  }
  if (input.kind === "unavailable_snapshot_source") {
    return classify(input.kind, "not_replayable", "source_unavailable");
  }
  if (
    input.kind === "live_provider_cache" ||
    input.kind === "production_clock_a" ||
    input.kind === "dataset_kpi"
  ) {
    return classify(input.kind, "not_replayable", "measurement_class_not_mechanism");
  }
  if (input.kind === "frozen_counterfactual") {
    if (input.identities_match !== true) {
      return classify(input.kind, "not_replayable", "counterfactual_identity_mismatch");
    }
    return classify(input.kind, "fixed_artifact_counterfactual", "identity_bound");
  }
  return classify(input.kind, "mechanism", "planted_contract");
}

function classify(
  kind: MechanismEvidenceKindV1,
  evidence_class: MechanismEvidenceClassV1,
  reason: string
): MechanismEvidenceClassificationV1 {
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_PROOF_MECHANISM_EVIDENCE_OPERATOR_ID,
    kind,
    evidence_class,
    reason
  });
}
