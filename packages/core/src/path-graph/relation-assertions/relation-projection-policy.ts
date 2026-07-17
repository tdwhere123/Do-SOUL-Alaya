import { createHash } from "node:crypto";
import {
  PathRelationSchema,
  isRelationValidityActiveAt,
  type PathGovernanceClass,
  type PathRelation,
  type RelationAssertion,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";

type ProjectionProfile = Readonly<{
  readonly governanceClass: PathGovernanceClass;
  readonly recallBias: number;
  readonly salience: number;
  readonly strength: number;
}>;

const projectionProfiles: Readonly<Record<string, ProjectionProfile>> = Object.freeze({
  answers_with: { governanceClass: "recall_allowed", recallBias: 0.5, salience: 0.5, strength: 0.5 },
  coheres_with: { governanceClass: "hint_only", recallBias: 0.5, salience: 0.3, strength: 0.3 },
  co_recalled: { governanceClass: "attention_only", recallBias: 0.5, salience: 0.3, strength: 0.3 },
  contradicts: { governanceClass: "recall_allowed", recallBias: -0.4, salience: 0.9, strength: 0.9 },
  derives_from: { governanceClass: "attention_only", recallBias: 0.5, salience: 0.5, strength: 0.5 },
  exception_to: { governanceClass: "recall_allowed", recallBias: 0, salience: 0.9, strength: 0.9 },
  incompatible_with: { governanceClass: "recall_allowed", recallBias: -0.3, salience: 0.9, strength: 0.9 },
  shares_entity: { governanceClass: "hint_only", recallBias: 0.5, salience: 0.2, strength: 0.2 },
  signal_graph_ref: { governanceClass: "recall_allowed", recallBias: 0.5, salience: 0.6, strength: 0.6 },
  supersedes: { governanceClass: "recall_allowed", recallBias: -0.5, salience: 0.9, strength: 0.9 },
  supports: { governanceClass: "attention_only", recallBias: 0.5, salience: 0.5, strength: 0.5 },
  time_concern: { governanceClass: "recall_allowed", recallBias: 0.7, salience: 0.6, strength: 0.4 }
});

export const TEMPORAL_RELATION_PROJECTION_POLICY_ID = "relation-path-projection-v1";
export const TEMPORAL_RELATION_PROJECTION_POLICY_SHA256 = createHash("sha256")
  .update(JSON.stringify(projectionProfiles))
  .digest("hex");

export function supportsTemporalRelationProjection(relationKind: string): boolean {
  return projectionProfiles[relationKind] !== undefined;
}

export function buildTemporalPathProjection(input: Readonly<{
  readonly assertion: Readonly<RelationAssertion>;
  readonly resolutions: readonly Readonly<RelationAssertionResolution>[];
  readonly asOf: string;
  readonly permittedTimelessPolicyIds: ReadonlySet<string>;
}>): Readonly<PathRelation> | null {
  const profile = projectionProfiles[input.assertion.relation_kind];
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
      evidence_basis: input.assertion.evidence_ids,
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
