import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";

const stabilityClassValues = ["volatile", "normal", "stable", "pinned"] as const;
const directionBiasValues = [
  "source_to_target",
  "target_to_source",
  "bidirectional_asymmetric"
] as const;
const pathGovernanceClassValues = [
  "hint_only",
  "attention_only",
  "recall_allowed",
  "strictly_governed"
] as const;
const pathLifecycleStatusValues = ["active", "retired", "dormant"] as const;
const manifestationPreferenceValues = ["stance_bias", "dialogue_nudge", "lens_entry"] as const;

export const StabilityClass = {
  VOLATILE: "volatile",
  NORMAL: "normal",
  STABLE: "stable",
  PINNED: "pinned"
} as const;

export const DirectionBias = {
  SOURCE_TO_TARGET: "source_to_target",
  TARGET_TO_SOURCE: "target_to_source",
  BIDIRECTIONAL_ASYMMETRIC: "bidirectional_asymmetric"
} as const;

export const PathGovernanceClass = {
  HINT_ONLY: "hint_only",
  ATTENTION_ONLY: "attention_only",
  RECALL_ALLOWED: "recall_allowed",
  STRICTLY_GOVERNED: "strictly_governed"
} as const;

export const PathLifecycleStatus = {
  ACTIVE: "active",
  RETIRED: "retired",
  // invariant: dormant leaves a path in DB with salience cleared and out of
  // recall, distinct from retired. active <-> dormant is reversible via
  // override; retired is terminal.
  DORMANT: "dormant"
} as const;

export const ManifestationPreference = {
  STANCE_BIAS: "stance_bias",
  DIALOGUE_NUDGE: "dialogue_nudge",
  LENS_ENTRY: "lens_entry"
} as const;

export const StabilityClassSchema = z.enum(stabilityClassValues);
export const DirectionBiasSchema = z.enum(directionBiasValues);
export const PathGovernanceClassSchema = z.enum(pathGovernanceClassValues);
export const PathLifecycleStatusSchema = z.enum(pathLifecycleStatusValues);
export const ManifestationPreferenceSchema = z.enum(manifestationPreferenceValues);

// invariant: only "active" paths participate in recall and activation. Both
// "retired" (terminal) and "dormant" (reversible cold storage) are excluded.
// A path whose status is unset is treated as active for backward
// compatibility with rows persisted before lifecycle.status was populated.
// see also: path-plasticity-service.ts (active <-> dormant transitions).
export function isPathActiveForRecall(
  status: PathLifecycleStatus | undefined
): boolean {
  return status === undefined || status === "active";
}

// invariant: recall-eligible = active lifecycle AND recall_bias > 0. The
// strict-positive gate admits the whole positive associative family and
// excludes both the negative families (recall_bias < 0: suppression, not
// positive amplification) and the recall-neutral exception_to marker
// (recall_bias == 0: topology marker, never a positive expansion
// candidate). Shared by every positive-expansion call site so the
// sign boundary cannot drift between producer and recall consumer.
// see also: recall-service.ts isPathExcludedFromRecall.
// see also: path-activation-candidate-producer.ts produce().
export function isPathRecallEligible(path: PathRelation): boolean {
  return isPathActiveForRecall(path.lifecycle.status) && path.effect_vector.recall_bias > 0;
}

// invariant: a negative path may actively demote (suppress) a recall target
// only when its governance band is recall_allowed or strictly_governed. The
// two lower bands (attention_only / hint_only) are reachable through
// agent-controllable co-occurrence seeding and plasticity reinforcement, where
// the only mutable signal is strength — strength can be inflated by replayed
// co-usage, so strength alone must never license suppression. Governance is the
// trust signal that is NOT agent-pumpable from recall traffic, so it gates the
// weaponizable suppression lane: a low-band negative still excludes its target
// from positive expansion (isPathRecallEligible already rejects recall_bias < 0)
// but cannot push a victim's fused score down. This mirrors the llm-only gate on
// the supersede_penalty karma path. The predicate is governance-only and does
// NOT re-check sign/lifecycle; suppression callers pass active negative paths
// and apply this as the additional governance condition.
// see also: recall-service.ts collectNegativePathSuppressions.
// see also: conflict-detection-service.ts supersede_penalty llm-only karma gate.
export function isPathGovernedForSuppression(path: PathRelation): boolean {
  return (
    path.legitimacy.governance_class === "recall_allowed" ||
    path.legitimacy.governance_class === "strictly_governed"
  );
}

const ObjectPathAnchorRefSchema = z
  .object({
    kind: z.literal("object"),
    object_id: NonEmptyStringSchema
  })
  .strict();

const ObjectFacetPathAnchorRefSchema = z
  .object({
    kind: z.literal("object_facet"),
    object_id: NonEmptyStringSchema,
    facet_key: NonEmptyStringSchema
  })
  .strict();

const ObligationPathAnchorRefSchema = z
  .object({
    kind: z.literal("obligation"),
    source_object_id: NonEmptyStringSchema,
    obligation_digest: NonEmptyStringSchema
  })
  .strict();

const RiskConcernPathAnchorRefSchema = z
  .object({
    kind: z.literal("risk_concern"),
    source_object_id: NonEmptyStringSchema,
    concern_digest: NonEmptyStringSchema
  })
  .strict();

const TimeConcernPathAnchorRefSchema = z
  .object({
    kind: z.literal("time_concern"),
    source_object_id: NonEmptyStringSchema,
    window_digest: NonEmptyStringSchema
  })
  .strict();

export const PathAnchorRefSchema = z
  .discriminatedUnion("kind", [
    ObjectPathAnchorRefSchema,
    ObjectFacetPathAnchorRefSchema,
    ObligationPathAnchorRefSchema,
    RiskConcernPathAnchorRefSchema,
    TimeConcernPathAnchorRefSchema
  ])
  .readonly();

export const PathEffectVectorSchema = z
  .object({
    salience: z.number(),
    recall_bias: z.number(),
    verification_bias: z.number(),
    unfinishedness_bias: z.number(),
    default_manifestation_preference: ManifestationPreferenceSchema
  })
  .strict()
  .readonly();

export const PathPlasticityStateSchema = z
  .object({
    strength: z.number(),
    direction_bias: DirectionBiasSchema,
    stability_class: StabilityClassSchema,
    support_events_count: NonNegativeIntSchema,
    contradiction_events_count: NonNegativeIntSchema,
    last_reinforced_at: IsoDatetimeStringSchema.optional(),
    last_weakened_at: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly();

const PathLifecycleSchema = z
  .object({
    status: PathLifecycleStatusSchema.optional(),
    retirement_rule: NonEmptyStringSchema,
    cooldown_rule: NonEmptyStringSchema.optional(),
    override_rule: NonEmptyStringSchema.optional()
  })
  .strict()
  .readonly();

const PathLegitimacySchema = z
  .object({
    evidence_basis: z.array(NonEmptyStringSchema).readonly(),
    governance_class: PathGovernanceClassSchema
  })
  .strict()
  .readonly();

export const PathRelationSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    anchors: z
      .object({
        source_anchor: PathAnchorRefSchema,
        target_anchor: PathAnchorRefSchema
      })
      .strict()
      .readonly(),
    constitution: z
      .object({
        relation_kind: NonEmptyStringSchema,
        why_this_relation_exists: z.array(NonEmptyStringSchema).readonly()
      })
      .strict()
      .readonly(),
    effect_vector: PathEffectVectorSchema,
    plasticity_state: PathPlasticityStateSchema,
    lifecycle: PathLifecycleSchema,
    legitimacy: PathLegitimacySchema,
    created_at: IsoDatetimeStringSchema,
    updated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type StabilityClass = z.infer<typeof StabilityClassSchema>;
export type DirectionBias = z.infer<typeof DirectionBiasSchema>;
export type PathGovernanceClass = z.infer<typeof PathGovernanceClassSchema>;
export type PathLifecycleStatus = z.infer<typeof PathLifecycleStatusSchema>;
export type ManifestationPreference = z.infer<typeof ManifestationPreferenceSchema>;
export type PathAnchorRef = z.infer<typeof PathAnchorRefSchema>;
export type PathEffectVector = z.infer<typeof PathEffectVectorSchema>;
export type PathRelation = z.infer<typeof PathRelationSchema>;
export type PathPlasticityState = z.infer<typeof PathPlasticityStateSchema>;

const recallsTierRelationKinds = new Set([
  "recalls",
  "co_recalled",
  "shares_entity",
  "signal_graph_ref"
]);

export interface PathRelationIdentityCandidate {
  readonly sourceAnchor: PathAnchorRef;
  readonly targetAnchor: PathAnchorRef;
  readonly relationKind: string;
  readonly recallBias: number;
}

export interface PathRelationIdentitySubject {
  readonly anchors: {
    readonly source_anchor: PathAnchorRef;
    readonly target_anchor: PathAnchorRef;
  };
  readonly constitution: {
    readonly relation_kind: string;
  };
  readonly effect_vector: {
    readonly recall_bias: number;
  };
}

export function getPathAnchorBackingObjectId(anchor: PathAnchorRef): string {
  switch (anchor.kind) {
    case "object":
    case "object_facet":
      return anchor.object_id;
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return anchor.source_object_id;
  }
}

export function pathRelationMatchesIdentity(
  relation: PathRelationIdentitySubject,
  candidate: PathRelationIdentityCandidate
): boolean {
  const relationFamily = pathRelationIdentityFamily(
    relation.constitution.relation_kind,
    relation.effect_vector.recall_bias
  );
  const candidateFamily = pathRelationIdentityFamily(
    candidate.relationKind,
    candidate.recallBias
  );
  if (relationFamily !== candidateFamily) {
    return false;
  }

  const relationSource = getPathAnchorBackingObjectId(relation.anchors.source_anchor);
  const relationTarget = getPathAnchorBackingObjectId(relation.anchors.target_anchor);
  const candidateSource = getPathAnchorBackingObjectId(candidate.sourceAnchor);
  const candidateTarget = getPathAnchorBackingObjectId(candidate.targetAnchor);

  if (relationFamily === "positive:recalls") {
    return (
      (relationSource === candidateSource && relationTarget === candidateTarget) ||
      (relationSource === candidateTarget && relationTarget === candidateSource)
    );
  }

  return relationSource === candidateSource && relationTarget === candidateTarget;
}

function pathRelationIdentityFamily(relationKind: string, recallBias: number): string {
  const sign = recallBias > 0 ? "positive" : recallBias < 0 ? "negative" : "neutral";
  if (sign === "positive" && recallsTierRelationKinds.has(relationKind)) {
    return "positive:recalls";
  }
  return `${sign}:${relationKind}`;
}
