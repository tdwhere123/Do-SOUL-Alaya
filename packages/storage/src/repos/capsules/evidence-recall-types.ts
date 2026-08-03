import type {
  AssociativeFactKeyProjectionForm,
  EvidenceCapsule,
  EvidenceSearchProjection
} from "@do-soul/alaya-protocol";

export type EvidenceSearchProjectionIdentity = Readonly<
  Pick<EvidenceSearchProjection, "projection_id" | "projection_kind">
>;

export interface EvidenceCapsuleKeywordHit {
  readonly object_id: string;
  readonly normalized_rank: number;
  readonly matched_projection?: EvidenceSearchProjectionIdentity;
}

export interface EvidenceSearchMatch {
  readonly object_id: string;
  readonly matched_projection?: EvidenceSearchProjectionIdentity;
}

export interface RecallQualifiedEvidence {
  readonly capsule: Readonly<EvidenceCapsule>;
  readonly verified_user_projection: boolean;
  readonly matched_projection?: Readonly<EvidenceSearchProjection>;
  readonly matched_fact_key_forms?: readonly Readonly<AssociativeFactKeyProjectionForm>[];
}
