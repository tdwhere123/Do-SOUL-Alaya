import type {
  AssociativeFactFrame,
  AssociativeFactKeyProjectionForm,
  EvidenceCapsule,
  EvidenceSearchProjection,
  OpenSemanticFactorFormationCapture,
  FtsLaneId,
  VerifiedUserAssertionCatalogLocator
} from "@do-soul/alaya-protocol";

export interface VerifiedAssertionLocatorResolutionInput {
  readonly sourceCorpus: string;
  readonly sourceAssertion: string;
  readonly sourceLocator: VerifiedUserAssertionCatalogLocator;
}

export type VerifiedAssertionLocatorResolver = (
  input: Readonly<VerifiedAssertionLocatorResolutionInput>
) => boolean;

export type EvidenceSearchProjectionIdentity = Readonly<
  Pick<EvidenceSearchProjection, "projection_id" | "projection_kind">
>;

export interface EvidenceCapsuleKeywordHit {
  readonly object_id: string;
  readonly normalized_rank: number;
  readonly matched_fts_lanes: readonly FtsLaneId[];
  readonly matched_projection?: EvidenceSearchProjectionIdentity;
}

export interface EvidenceKeywordFieldResult {
  readonly matches: readonly Readonly<EvidenceCapsuleKeywordHit>[];
  readonly lanes: readonly Readonly<{
    readonly lane: FtsLaneId;
    readonly status: "complete" | "truncated" | "unavailable" | "ineligible";
    readonly depth: number;
    readonly observations: readonly Readonly<
      EvidenceCapsuleKeywordHit & { readonly rank: number; readonly source_id: string }
    >[];
    readonly unseen_upper_bound: number | null;
  }>[];
  readonly refinement_levels?: readonly Readonly<{
    readonly requested_depth: number;
    readonly matches: readonly Readonly<EvidenceCapsuleKeywordHit>[];
    readonly lanes: EvidenceKeywordFieldResult["lanes"];
  }>[];
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
  readonly matched_fact_frame?: Readonly<AssociativeFactFrame>;
  readonly semantic_factor_formation?: Readonly<OpenSemanticFactorFormationCapture>;
  readonly kind_projection_drafts?: readonly Readonly<{
    readonly factor_id: string;
    readonly kind_values: readonly string[];
  }>[];
}
