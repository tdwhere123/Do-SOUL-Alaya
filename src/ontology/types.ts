import type { PersistentObjectEnvelope } from "../foundation/types.js";

export const evidenceKinds = [
  "user_statement",
  "code_observation",
  "tool_output",
  "conversation_excerpt",
  "file_content",
  "external_reference",
  "inferred"
] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];

export const evidenceHealthStates = ["verified", "questionable", "degraded", "broken"] as const;
export type EvidenceHealthState = (typeof evidenceHealthStates)[number];

export interface SemanticAnchor {
  readonly topic: string;
  readonly keywords: readonly string[];
  readonly summary: string;
}

export interface EventAnchor {
  readonly event_type: string;
  readonly event_id: string | null;
  readonly occurred_at: string;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface PhysicalAnchor {
  readonly file_path: string | null;
  readonly line_range: LineRange | null;
  readonly symbol_name: string | null;
  readonly artifact_ref: string | null;
}

export interface EvidenceCapsule extends PersistentObjectEnvelope {
  readonly object_kind: "evidence_capsule";
  readonly evidence_kind: EvidenceKind;
  readonly semantic_anchor: SemanticAnchor;
  readonly event_anchor: EventAnchor | null;
  readonly physical_anchor: PhysicalAnchor | null;
  readonly evidence_health_state: EvidenceHealthState;
  readonly gist: string;
  readonly excerpt: string | null;
  readonly source_hash: string | null;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly surface_id: string | null;
}

export const memoryDimensions = [
  "preference",
  "constraint",
  "decision",
  "procedure",
  "fact",
  "hazard",
  "glossary",
  "episode"
] as const;
export type MemoryDimension = (typeof memoryDimensions)[number];

export const sourceKinds = ["compiler", "user", "seed", "import", "review"] as const;
export type SourceKind = (typeof sourceKinds)[number];

export const formationKinds = ["extracted", "explicit", "inferred", "derived", "imported"] as const;
export type FormationKind = (typeof formationKinds)[number];

export const scopeClasses = ["project", "global_domain", "global_core"] as const;
export type ScopeClass = (typeof scopeClasses)[number];

export const storageTiers = ["hot", "cold"] as const;
export type StorageTier = (typeof storageTiers)[number];

export const manifestationStates = ["hidden", "hint", "excerpt", "full_eligible"] as const;
export type ManifestationState = (typeof manifestationStates)[number];

export const retentionStates = ["working", "consolidated", "canon", "archived", "tombstoned"] as const;
export type RetentionState = (typeof retentionStates)[number];

export const decayProfiles = ["pinned", "stable", "normal", "volatile", "hazard"] as const;
export type DecayProfile = (typeof decayProfiles)[number];

export interface MemoryEntry extends PersistentObjectEnvelope {
  readonly object_kind: "memory_entry";
  readonly dimension: MemoryDimension;
  readonly source_kind: SourceKind;
  readonly formation_kind: FormationKind;
  readonly scope_class: ScopeClass;
  readonly content: string;
  readonly domain_tags: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly storage_tier: StorageTier;
  readonly activation_score: number | null;
  readonly retention_score: number | null;
  readonly manifestation_state: ManifestationState | null;
  readonly retention_state: RetentionState | null;
  readonly decay_profile: DecayProfile | null;
  readonly confidence: number | null;
  readonly last_used_at: string | null;
  readonly last_hit_at: string | null;
  readonly reinforcement_count: number | null;
  readonly contradiction_count: number | null;
  readonly superseded_by: string | null;
}

export const synthesisTypes = ["phase_synthesis", "cross_evidence", "pattern_detection"] as const;
export type SynthesisType = (typeof synthesisTypes)[number];

export const synthesisStatuses = ["working", "stable", "superseded", "archived"] as const;
export type SynthesisStatus = (typeof synthesisStatuses)[number];

export const synthesisPromotionStates = ["none", "candidate", "proposed", "promoted", "rejected"] as const;
export type SynthesisPromotionState = (typeof synthesisPromotionStates)[number];

export interface SynthesisCapsule extends PersistentObjectEnvelope {
  readonly object_kind: "synthesis_capsule";
  readonly topic_key: string;
  readonly synthesis_type: SynthesisType;
  readonly authority_round_count: number;
  readonly cooldown_until: string | null;
  readonly promotion_state: SynthesisPromotionState;
  readonly summary: string;
  readonly evidence_refs: readonly string[];
  readonly source_memory_refs: readonly string[];
  readonly workspace_id: string;
  readonly run_id: string;
  readonly synthesis_status: SynthesisStatus;
}

export const claimKinds = ["constraint", "preference", "procedure", "exception", "factual_policy"] as const;
export type ClaimKind = (typeof claimKinds)[number];

export const enforcementLevels = ["strict", "preferred"] as const;
export type EnforcementLevel = (typeof enforcementLevels)[number];

export const originTiers = ["user_explicit", "compiler_extracted", "review_accepted", "seed", "imported"] as const;
export type OriginTier = (typeof originTiers)[number];

export const precedenceBases = ["recency", "authority", "evidence_strength", "user_override"] as const;
export type PrecedenceBasis = (typeof precedenceBases)[number];

export const claimLifecycleStates = ["draft", "active", "contested", "winner", "superseded", "rejected", "archived"] as const;
export type ClaimLifecycleState = (typeof claimLifecycleStates)[number];

export interface GovernanceSubject {
  readonly subject_type: string;
  readonly subject_ref: string;
}

export interface ClaimForm extends PersistentObjectEnvelope {
  readonly object_kind: "claim_form";
  readonly governance_subject: GovernanceSubject;
  readonly claim_kind: ClaimKind;
  readonly scope_class: ScopeClass;
  readonly enforcement_level: EnforcementLevel;
  readonly origin_tier: OriginTier;
  readonly precedence_basis: PrecedenceBasis;
  readonly proposition_digest: string;
  readonly evidence_refs: readonly string[];
  readonly source_object_refs: readonly string[];
  readonly workspace_id: string;
  readonly claim_status: ClaimLifecycleState;
}

export type OntologyRecord = EvidenceCapsule | MemoryEntry | SynthesisCapsule | ClaimForm;
