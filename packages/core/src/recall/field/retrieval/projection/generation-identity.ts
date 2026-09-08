import {
  FIELD_CONTRACT_SCHEMA_VERSION,
  CONDITIONAL_FIELD_OPERATOR_MANIFEST,
  CONDITIONAL_FIELD_GENERATION_OPERATOR_ID,
  FieldProjectionGenerationSchema,
  conditionalFieldOperatorManifestDigest,
  hashGenerationId,
  verifyFieldProjectionGeneration,
  type FieldContractSha256,
  type FieldProjectionGeneration,
  type ProjectionGenerationStatus
} from "@do-soul/alaya-protocol";

export type ProjectionGenerationDraft = Readonly<{
  readonly workspace_id: string;
  readonly input_event_frontier: string;
  readonly governance_frontier: string;
  readonly status: ProjectionGenerationStatus;
  readonly recorded_at: string;
}>;

export function projectionGenerationId(
  inputEventFrontier: string,
  governanceFrontier: string,
  sha256: FieldContractSha256
): string {
  const operators = CONDITIONAL_FIELD_OPERATOR_MANIFEST;
  return hashGenerationId({
    operators,
    operator_manifest_digest: conditionalFieldOperatorManifestDigest(sha256),
    field_schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
    input_event_frontier: inputEventFrontier,
    governance_frontier: governanceFrontier
  }, sha256);
}

export function createProjectionGenerationReceipt(
  draft: ProjectionGenerationDraft,
  sha256: FieldContractSha256
): FieldProjectionGeneration {
  const generationId = projectionGenerationId(
    draft.input_event_frontier,
    draft.governance_frontier,
    sha256
  );
  const receipt = FieldProjectionGenerationSchema.parse({
    schema_version: 1,
    producer: CONDITIONAL_FIELD_GENERATION_OPERATOR_ID,
    consumer: "conditional_field_snapshot",
    identity: generationId,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "rebuildable",
    workspace_id: draft.workspace_id,
    generation_id: generationId,
    operator_manifest_digest: conditionalFieldOperatorManifestDigest(sha256),
    operator_versions: operatorVersionTuples(),
    field_schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
    input_event_frontier: draft.input_event_frontier,
    governance_frontier: draft.governance_frontier,
    status: draft.status,
    recorded_at: draft.recorded_at
  });
  return verifyConditionalProjectionGeneration(receipt, sha256);
}

export function verifyConditionalProjectionGeneration(
  receipt: FieldProjectionGeneration,
  sha256: FieldContractSha256
): FieldProjectionGeneration {
  const verified = verifyFieldProjectionGeneration(receipt, sha256);
  if (verified.producer !== CONDITIONAL_FIELD_GENERATION_OPERATOR_ID) {
    throw new Error("conditional field lifecycle cannot approve a historical projection manifest");
  }
  return verified;
}

function operatorVersionTuples(): readonly (readonly [string, string])[] {
  return Object.freeze(CONDITIONAL_FIELD_OPERATOR_MANIFEST.map((entry) =>
    Object.freeze([entry.id, entry.version] as const)
  ));
}
