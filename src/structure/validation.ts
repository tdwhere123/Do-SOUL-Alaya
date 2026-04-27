import {
  assertIsoDatetime,
  assertNonNegativeInteger,
  assertNumber,
  assertObject,
  assertOneOf,
  assertText,
  assertTextArray
} from "../foundation/validation.js";
import { AlayaValidationError } from "../runtime/audit-types.js";
import type {
  ActivationCandidate,
  ManifestationBudgetConfig,
  PathAnchorRef,
  PathEffectVector,
  PathLifecycle,
  PathLegitimacy,
  PathPlasticityState,
  PathRelation
} from "./types.js";
import {
  directionBiases,
  manifestationLevels,
  pathAnchorKinds,
  pathGovernanceClasses,
  pathLifecycleStates,
  stabilityClasses
} from "./types.js";

export function validatePathRelation(relation: PathRelation): PathRelation {
  assertObject(relation, "PathRelation");
  assertText(relation.path_id, "path_id");
  assertText(relation.workspace_id, "workspace_id");
  assertObject(relation.anchors, "anchors");
  validatePathAnchorRef(relation.anchors.source_anchor);
  validatePathAnchorRef(relation.anchors.target_anchor);
  assertObject(relation.constitution, "constitution");
  assertText(relation.constitution.relation_kind, "constitution.relation_kind");
  assertTextArray(relation.constitution.why_this_relation_exists, "constitution.why_this_relation_exists", { nonEmpty: true });
  validatePathEffectVector(relation.effect_vector, "effect_vector");
  validatePathPlasticityState(relation.plasticity_state);
  validatePathLifecycle(relation.lifecycle);
  validatePathLegitimacy(relation.legitimacy);
  assertIsoDatetime(relation.created_at, "created_at");
  assertIsoDatetime(relation.updated_at, "updated_at");
  return relation;
}

export function validateActivationCandidate(candidate: ActivationCandidate): ActivationCandidate {
  assertObject(candidate, "ActivationCandidate");
  assertText(candidate.candidate_id, "candidate_id");
  assertText(candidate.workspace_id, "workspace_id");
  assertText(candidate.run_id, "run_id");
  assertText(candidate.source_path_id, "source_path_id");
  validatePathAnchorRef(candidate.source_anchor);
  validatePathAnchorRef(candidate.target_anchor);
  assertText(candidate.why_now, "why_now");
  validatePathEffectVector(candidate.effect_vector_snapshot, "effect_vector_snapshot");
  assertNumber(candidate.pressure, "pressure");
  assertNumber(candidate.confidence, "confidence");
  assertOneOf(candidate.governance_ceiling, pathGovernanceClasses, "governance_ceiling");
  assertIsoDatetime(candidate.created_at, "created_at");
  return candidate;
}

export function validateManifestationBudgetConfig(config: ManifestationBudgetConfig): ManifestationBudgetConfig {
  assertObject(config, "ManifestationBudgetConfig");
  assertText(config.workspace_id, "workspace_id");
  assertNonNegativeInteger(config.stance_bias_cap, "stance_bias_cap");
  assertNonNegativeInteger(config.dialogue_nudge_cap, "dialogue_nudge_cap");
  assertNonNegativeInteger(config.lens_entry_cap, "lens_entry_cap");
  assertObject(config.escalation_policy, "escalation_policy");
  assertNumber(config.escalation_policy.nudge_min_pressure, "escalation_policy.nudge_min_pressure");
  assertNumber(config.escalation_policy.nudge_min_confidence, "escalation_policy.nudge_min_confidence");
  assertNumber(config.escalation_policy.lens_min_pressure, "escalation_policy.lens_min_pressure");
  assertNumber(config.escalation_policy.lens_min_confidence, "escalation_policy.lens_min_confidence");
  assertBoolean(config.escalation_policy.lens_requires_task_coupling, "escalation_policy.lens_requires_task_coupling");
  assertBoolean(config.escalation_policy.lens_requires_governance_ceiling, "escalation_policy.lens_requires_governance_ceiling");
  assertIsoDatetime(config.updated_at, "updated_at");
  return config;
}

export function serializePathAnchorRef(anchor: PathAnchorRef): string {
  validatePathAnchorRef(anchor);
  switch (anchor.kind) {
    case "object":
      return `object:${anchor.object_id}`;
    case "object_facet":
      return `object_facet:${anchor.object_id}:${anchor.facet_key}`;
    case "obligation":
      return `obligation:${anchor.source_object_id}:${anchor.obligation_digest}`;
    case "risk_concern":
      return `risk_concern:${anchor.source_object_id}:${anchor.concern_digest}`;
    case "time_concern":
      return `time_concern:${anchor.source_object_id}:${anchor.window_digest}`;
  }
}

export function listPathAnchorRefContextRefs(anchor: PathAnchorRef): readonly string[] {
  validatePathAnchorRef(anchor);
  switch (anchor.kind) {
    case "object":
      return [anchor.object_id];
    case "object_facet":
      return [anchor.object_id, `${anchor.object_id}#${anchor.facet_key}`];
    case "obligation":
      return [anchor.source_object_id, anchor.obligation_digest];
    case "risk_concern":
      return [anchor.source_object_id, anchor.concern_digest];
    case "time_concern":
      return [anchor.source_object_id, anchor.window_digest];
  }
}

function validatePathAnchorRef(anchor: PathAnchorRef): void {
  assertObject(anchor, "PathAnchorRef");
  assertOneOf(anchor.kind, pathAnchorKinds, "PathAnchorRef.kind");
  switch (anchor.kind) {
    case "object":
      assertText(anchor.object_id, "PathAnchorRef.object_id");
      break;
    case "object_facet":
      assertText(anchor.object_id, "PathAnchorRef.object_id");
      assertText(anchor.facet_key, "PathAnchorRef.facet_key");
      break;
    case "obligation":
      assertText(anchor.source_object_id, "PathAnchorRef.source_object_id");
      assertText(anchor.obligation_digest, "PathAnchorRef.obligation_digest");
      break;
    case "risk_concern":
      assertText(anchor.source_object_id, "PathAnchorRef.source_object_id");
      assertText(anchor.concern_digest, "PathAnchorRef.concern_digest");
      break;
    case "time_concern":
      assertText(anchor.source_object_id, "PathAnchorRef.source_object_id");
      assertText(anchor.window_digest, "PathAnchorRef.window_digest");
      break;
  }
}

function validatePathEffectVector(effect: PathEffectVector, label: string): void {
  assertObject(effect, label);
  assertNumber(effect.salience, `${label}.salience`);
  assertNumber(effect.recall_bias, `${label}.recall_bias`);
  assertNumber(effect.verification_bias, `${label}.verification_bias`);
  assertNumber(effect.unfinishedness_bias, `${label}.unfinishedness_bias`);
  assertOneOf(effect.default_manifestation_preference, manifestationLevels, `${label}.default_manifestation_preference`);
}

function validatePathPlasticityState(state: PathPlasticityState): void {
  assertObject(state, "plasticity_state");
  assertNumber(state.strength, "plasticity_state.strength");
  assertOneOf(state.direction_bias, directionBiases, "plasticity_state.direction_bias");
  assertOneOf(state.stability_class, stabilityClasses, "plasticity_state.stability_class");
  assertNonNegativeInteger(state.support_events_count, "plasticity_state.support_events_count");
  assertNonNegativeInteger(state.contradiction_events_count, "plasticity_state.contradiction_events_count");
  if (state.last_reinforced_at !== undefined) {
    assertIsoDatetime(state.last_reinforced_at, "plasticity_state.last_reinforced_at");
  }
  if (state.last_weakened_at !== undefined) {
    assertIsoDatetime(state.last_weakened_at, "plasticity_state.last_weakened_at");
  }
}

function validatePathLifecycle(lifecycle: PathLifecycle): void {
  assertObject(lifecycle, "lifecycle");
  assertOneOf(lifecycle.state, pathLifecycleStates, "lifecycle.state");
  assertText(lifecycle.retirement_rule, "lifecycle.retirement_rule");
  if (lifecycle.cooldown_rule !== undefined) {
    assertText(lifecycle.cooldown_rule, "lifecycle.cooldown_rule");
  }
  if (lifecycle.override_rule !== undefined) {
    assertText(lifecycle.override_rule, "lifecycle.override_rule");
  }
}

function validatePathLegitimacy(legitimacy: PathLegitimacy): void {
  assertObject(legitimacy, "legitimacy");
  assertTextArray(legitimacy.evidence_basis, "legitimacy.evidence_basis", { nonEmpty: true });
  assertOneOf(legitimacy.governance_class, pathGovernanceClasses, "legitimacy.governance_class");
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new AlayaValidationError(`${label} must be boolean.`);
  }
}
