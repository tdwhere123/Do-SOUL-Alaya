import {
  PROJECTION_GENERATION_OPERATOR_ID,
  ProjectionEraseBarrierSchema,
  hashLabeledIdentity,
  type FieldContractSha256,
  type ProjectionEraseBarrier,
  type ProjectionEraseSubjectKind
} from "@do-soul/alaya-protocol";

export type ProjectionEraseBarrierDraft = Readonly<{
  readonly workspace_id: string;
  readonly barrier_id: string;
  readonly generation_id: string | null;
  readonly subject_kind: ProjectionEraseSubjectKind;
  readonly subject_id: string;
  readonly erased_at: string;
}>;

export function createProjectionEraseBarrier(
  draft: ProjectionEraseBarrierDraft,
  sha256: FieldContractSha256
): ProjectionEraseBarrier {
  return ProjectionEraseBarrierSchema.parse({
    schema_version: 1,
    producer: PROJECTION_GENERATION_OPERATOR_ID,
    consumer: "projection_reader",
    identity: hashLabeledIdentity("erase_barrier", [
      draft.workspace_id,
      draft.subject_kind,
      draft.subject_id,
      draft.generation_id ?? ""
    ], sha256),
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "tombstone",
    deletion_behavior: "content_free_tombstone",
    workspace_id: draft.workspace_id,
    barrier_id: draft.barrier_id,
    generation_id: draft.generation_id,
    subject_kind: draft.subject_kind,
    subject_id: draft.subject_id,
    erased_at: draft.erased_at
  });
}

export function sameProjectionEraseBarrier(
  existing: ProjectionEraseBarrier,
  incoming: ProjectionEraseBarrier
): boolean {
  return existing.generation_id === incoming.generation_id &&
    existing.subject_kind === incoming.subject_kind &&
    existing.subject_id === incoming.subject_id;
}
