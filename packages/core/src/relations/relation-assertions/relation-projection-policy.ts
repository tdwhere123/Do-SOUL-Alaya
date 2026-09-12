import {
  PathRelationSchema,
  TEMPORAL_RELATION_PROJECTION_PROFILES,
  isRelationValidityActiveAt,
  type PathRelation,
  type RelationAssertion,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";

export {
  TEMPORAL_RELATION_PROJECTION_POLICY_ID,
  TEMPORAL_RELATION_PROJECTION_POLICY_SHA256
} from "@do-soul/alaya-protocol";

export function supportsTemporalRelationProjection(relationKind: string): boolean {
  return TEMPORAL_RELATION_PROJECTION_PROFILES[relationKind] !== undefined;
}

export function buildTemporalPathProjection(input: Readonly<{
  readonly assertion: Readonly<RelationAssertion>;
  readonly resolutions: readonly Readonly<RelationAssertionResolution>[];
  readonly asOf: string;
  readonly permittedTimelessPolicyIds: ReadonlySet<string>;
}>): Readonly<PathRelation> | null {
  const profile = TEMPORAL_RELATION_PROJECTION_PROFILES[input.assertion.relation_kind];
  if (profile === undefined || hasResolutionAtOrBefore(input.resolutions, input.asOf)) {
    return null;
  }
  if (
    !isRelationValidityActiveAt(
      input.assertion.validity,
      input.asOf,
      input.permittedTimelessPolicyIds
    )
  ) {
    return null;
  }
  return PathRelationSchema.parse({
    path_id: input.assertion.assertion_id,
    workspace_id: input.assertion.workspace_id,
    anchors: input.assertion.anchors,
    constitution: {
      relation_kind: input.assertion.relation_kind,
      why_this_relation_exists: [`temporal assertion ${input.assertion.assertion_id}`]
    },
    effect_vector: {
      salience: profile.salience,
      recall_bias: profile.recallBias,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: profile.strength,
      direction_bias: "bidirectional_asymmetric",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: input.assertion.evidence_receipts.map((receipt) => receipt.evidence_id),
      governance_class: profile.governanceClass
    },
    created_at: input.assertion.admitted_at,
    updated_at: input.assertion.admitted_at
  });
}

function hasResolutionAtOrBefore(
  resolutions: readonly Readonly<RelationAssertionResolution>[],
  asOf: string
): boolean {
  const instant = Date.parse(asOf);
  return resolutions.some((resolution) => Date.parse(resolution.resolved_at) <= instant);
}
