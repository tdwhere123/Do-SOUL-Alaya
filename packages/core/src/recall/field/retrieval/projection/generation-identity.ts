import {
  FIELD_CONTRACT_SCHEMA_VERSION,
  FIELD_OPERATOR_MANIFEST,
  FieldProjectionGenerationSchema,
  PROJECTION_GENERATION_OPERATOR_ID,
  fieldOperatorManifestDigest,
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
  const operators = FIELD_OPERATOR_MANIFEST;
  return hashGenerationId({
    operators,
    operator_manifest_digest: fieldOperatorManifestDigest(sha256),
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
    producer: PROJECTION_GENERATION_OPERATOR_ID,
    consumer: "activation",
    identity: generationId,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "rebuildable",
    workspace_id: draft.workspace_id,
    generation_id: generationId,
    operator_manifest_digest: fieldOperatorManifestDigest(sha256),
    operator_versions: operatorVersionTuples(),
    field_schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
    input_event_frontier: draft.input_event_frontier,
    governance_frontier: draft.governance_frontier,
    status: draft.status,
    recorded_at: draft.recorded_at
  });
  return verifyFieldProjectionGeneration(receipt, sha256);
}

export function withProjectionGenerationStatus(
  receipt: FieldProjectionGeneration,
  status: ProjectionGenerationStatus,
  sha256: FieldContractSha256
): FieldProjectionGeneration {
  return verifyFieldProjectionGeneration(
    FieldProjectionGenerationSchema.parse({ ...receipt, status }),
    sha256
  );
}

export function sameProjectionGenerationIdentity(
  existing: FieldProjectionGeneration,
  incoming: FieldProjectionGeneration
): boolean {
  return existing.operator_manifest_digest === incoming.operator_manifest_digest &&
    JSON.stringify(existing.operator_versions) === JSON.stringify(incoming.operator_versions) &&
    existing.field_schema_version === incoming.field_schema_version &&
    existing.input_event_frontier === incoming.input_event_frontier &&
    existing.governance_frontier === incoming.governance_frontier;
}

function operatorVersionTuples(): readonly (readonly [string, string])[] {
  return Object.freeze(FIELD_OPERATOR_MANIFEST.map((entry) =>
    Object.freeze([entry.id, entry.version] as const)
  ));
}
