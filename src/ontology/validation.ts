import { objectLifecycleStates, ontologyObjectKinds } from "../foundation/types.js";
import {
  assertIsoDatetime,
  assertNonNegativeInteger,
  assertNullableText,
  assertObject,
  assertOneOf,
  assertPositiveInteger,
  assertText,
  assertTextArray,
  assertUnitInterval
} from "../foundation/validation.js";
import { AlayaValidationError } from "../runtime/audit-types.js";
import type {
  ClaimForm,
  EvidenceCapsule,
  EventAnchor,
  GovernanceSubject,
  LineRange,
  MemoryEntry,
  OntologyRecord,
  PhysicalAnchor,
  SemanticAnchor,
  SynthesisCapsule
} from "./types.js";
import {
  claimKinds,
  claimLifecycleStates,
  decayProfiles,
  enforcementLevels,
  evidenceHealthStates,
  evidenceKinds,
  formationKinds,
  manifestationStates,
  memoryDimensions,
  originTiers,
  precedenceBases,
  retentionStates,
  scopeClasses,
  sourceKinds,
  storageTiers,
  synthesisPromotionStates,
  synthesisStatuses,
  synthesisTypes
} from "./types.js";

export function validateOntologyRecord(record: OntologyRecord): OntologyRecord {
  switch (record.object_kind) {
    case "evidence_capsule":
      return validateEvidenceCapsule(record);
    case "memory_entry":
      return validateMemoryEntry(record);
    case "synthesis_capsule":
      return validateSynthesisCapsule(record);
    case "claim_form":
      return validateClaimForm(record);
  }
}

export function validateEvidenceCapsule(record: EvidenceCapsule): EvidenceCapsule {
  validatePersistentEnvelope(record, "evidence_capsule");
  assertOneOf(record.evidence_kind, evidenceKinds, "evidence_kind");
  validateSemanticAnchor(record.semantic_anchor);
  if (record.event_anchor !== null) {
    validateEventAnchor(record.event_anchor);
  }
  if (record.physical_anchor !== null) {
    validatePhysicalAnchor(record.physical_anchor);
  }
  assertOneOf(record.evidence_health_state, evidenceHealthStates, "evidence_health_state");
  assertText(record.gist, "gist");
  assertNullableText(record.excerpt, "excerpt");
  assertNullableText(record.source_hash, "source_hash");
  assertText(record.run_id, "run_id");
  assertText(record.workspace_id, "workspace_id");
  assertNullableText(record.surface_id, "surface_id");
  return record;
}

export function validateMemoryEntry(record: MemoryEntry): MemoryEntry {
  validatePersistentEnvelope(record, "memory_entry");
  assertOneOf(record.dimension, memoryDimensions, "dimension");
  assertOneOf(record.source_kind, sourceKinds, "source_kind");
  assertOneOf(record.formation_kind, formationKinds, "formation_kind");
  assertOneOf(record.scope_class, scopeClasses, "scope_class");
  assertText(record.content, "content");
  assertTextArray(record.domain_tags, "domain_tags");
  assertTextArray(record.evidence_refs, "evidence_refs", { nonEmpty: true });
  assertText(record.workspace_id, "workspace_id");
  assertText(record.run_id, "run_id");
  assertNullableText(record.surface_id, "surface_id");
  assertOneOf(record.storage_tier, storageTiers, "storage_tier");
  assertNullableUnit(record.activation_score, "activation_score");
  assertNullableUnit(record.retention_score, "retention_score");
  assertNullableOneOf(record.manifestation_state, manifestationStates, "manifestation_state");
  assertNullableOneOf(record.retention_state, retentionStates, "retention_state");
  assertNullableOneOf(record.decay_profile, decayProfiles, "decay_profile");
  assertNullableUnit(record.confidence, "confidence");
  assertNullableIso(record.last_used_at, "last_used_at");
  assertNullableIso(record.last_hit_at, "last_hit_at");
  assertNullableNonNegativeInteger(record.reinforcement_count, "reinforcement_count");
  assertNullableNonNegativeInteger(record.contradiction_count, "contradiction_count");
  assertNullableText(record.superseded_by, "superseded_by");
  return record;
}

export function validateSynthesisCapsule(record: SynthesisCapsule): SynthesisCapsule {
  validatePersistentEnvelope(record, "synthesis_capsule");
  assertText(record.topic_key, "topic_key");
  assertOneOf(record.synthesis_type, synthesisTypes, "synthesis_type");
  assertNonNegativeInteger(record.authority_round_count, "authority_round_count");
  assertNullableIso(record.cooldown_until, "cooldown_until");
  assertOneOf(record.promotion_state, synthesisPromotionStates, "promotion_state");
  assertText(record.summary, "summary");
  assertTextArray(record.evidence_refs, "evidence_refs", { nonEmpty: true });
  assertTextArray(record.source_memory_refs, "source_memory_refs", { nonEmpty: true });
  assertText(record.workspace_id, "workspace_id");
  assertText(record.run_id, "run_id");
  assertOneOf(record.synthesis_status, synthesisStatuses, "synthesis_status");
  return record;
}

export function validateClaimForm(record: ClaimForm): ClaimForm {
  validatePersistentEnvelope(record, "claim_form");
  validateGovernanceSubject(record.governance_subject);
  assertOneOf(record.claim_kind, claimKinds, "claim_kind");
  assertOneOf(record.scope_class, scopeClasses, "scope_class");
  assertOneOf(record.enforcement_level, enforcementLevels, "enforcement_level");
  assertOneOf(record.origin_tier, originTiers, "origin_tier");
  assertOneOf(record.precedence_basis, precedenceBases, "precedence_basis");
  assertText(record.proposition_digest, "proposition_digest");
  assertTextArray(record.evidence_refs, "evidence_refs", { nonEmpty: true });
  assertTextArray(record.source_object_refs, "source_object_refs", { nonEmpty: true });
  assertText(record.workspace_id, "workspace_id");
  assertOneOf(record.claim_status, claimLifecycleStates, "claim_status");
  return record;
}

export function assertEvidenceCanSupportDurableWrite(evidence: EvidenceCapsule): void {
  validateEvidenceCapsule(evidence);
  if (evidence.evidence_health_state === "broken") {
    throw new AlayaValidationError(`Evidence ${evidence.object_id} is broken and cannot support durable writes.`);
  }
}

function validatePersistentEnvelope(record: OntologyRecord, expectedKind: OntologyRecord["object_kind"]): void {
  assertObject(record, expectedKind);
  assertText(record.object_id, "object_id");
  assertOneOf(record.object_kind, ontologyObjectKinds, "object_kind");
  if (record.object_kind !== expectedKind) {
    throw new AlayaValidationError(`Expected ${expectedKind}; received ${record.object_kind}.`);
  }
  assertPositiveInteger(record.schema_version, "schema_version");
  assertIsoDatetime(record.created_at, "created_at");
  assertIsoDatetime(record.updated_at, "updated_at");
  assertText(record.created_by, "created_by");
  assertOneOf(record.lifecycle_state, objectLifecycleStates, "lifecycle_state");
}

function validateSemanticAnchor(anchor: SemanticAnchor): void {
  assertObject(anchor, "semantic_anchor");
  assertText(anchor.topic, "semantic_anchor.topic");
  assertTextArray(anchor.keywords, "semantic_anchor.keywords");
  assertText(anchor.summary, "semantic_anchor.summary");
}

function validateEventAnchor(anchor: EventAnchor): void {
  assertObject(anchor, "event_anchor");
  assertText(anchor.event_type, "event_anchor.event_type");
  assertNullableText(anchor.event_id, "event_anchor.event_id");
  assertIsoDatetime(anchor.occurred_at, "event_anchor.occurred_at");
}

function validatePhysicalAnchor(anchor: PhysicalAnchor): void {
  assertObject(anchor, "physical_anchor");
  assertNullableText(anchor.file_path, "physical_anchor.file_path");
  if (anchor.line_range !== null) {
    validateLineRange(anchor.line_range);
  }
  assertNullableText(anchor.symbol_name, "physical_anchor.symbol_name");
  assertNullableText(anchor.artifact_ref, "physical_anchor.artifact_ref");
  if (
    anchor.file_path === null &&
    anchor.line_range === null &&
    anchor.symbol_name === null &&
    anchor.artifact_ref === null
  ) {
    throw new AlayaValidationError("physical_anchor must include at least one locator.");
  }
}

function validateLineRange(range: LineRange): void {
  assertObject(range, "line_range");
  assertNonNegativeInteger(range.start, "line_range.start");
  assertNonNegativeInteger(range.end, "line_range.end");
  if (range.start > range.end) {
    throw new AlayaValidationError("line_range.start must be less than or equal to line_range.end.");
  }
}

function validateGovernanceSubject(subject: GovernanceSubject): void {
  assertObject(subject, "governance_subject");
  assertText(subject.subject_type, "governance_subject.subject_type");
  assertText(subject.subject_ref, "governance_subject.subject_ref");
}

function assertNullableOneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): asserts value is T[number] | null {
  if (value !== null) {
    assertOneOf(value, allowed, label);
  }
}

function assertNullableIso(value: unknown, label: string): asserts value is string | null {
  if (value !== null) {
    assertIsoDatetime(value, label);
  }
}

function assertNullableUnit(value: unknown, label: string): asserts value is number | null {
  if (value !== null) {
    assertUnitInterval(value, label);
  }
}

function assertNullableNonNegativeInteger(value: unknown, label: string): asserts value is number | null {
  if (value !== null) {
    assertNonNegativeInteger(value, label);
  }
}
