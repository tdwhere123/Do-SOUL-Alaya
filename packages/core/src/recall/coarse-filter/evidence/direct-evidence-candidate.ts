import {
  hasGardenSourceTurnFallbackAnyReceiptFormat,
  type EvidenceCapsule,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { createBoundedNonMemoryPreview } from "../non-memory-preview.js";

export function isDirectRecallEvidence(
  evidence: Readonly<EvidenceCapsule>,
  workspaceId: string
): boolean {
  const artifactRef = evidence.physical_anchor?.artifact_ref;
  return evidence.workspace_id === workspaceId &&
    evidence.lifecycle_state === "active" &&
    evidence.created_by === "garden_compile" &&
    evidence.evidence_health_state === "verified" &&
    evidence.evidence_kind === "conversation_excerpt" &&
    hasGardenSourceTurnFallbackAnyReceiptFormat({
      artifact_ref: artifactRef ?? null,
      source_hash: evidence.source_hash
    });
}

export function buildDirectEvidencePseudoMemoryEntry(
  evidence: Readonly<EvidenceCapsule>,
  normalizedRank: number,
  recallText: string = resolveDirectEvidenceRecallText(evidence)
): Readonly<MemoryEntry> {
  return Object.freeze({
    object_id: evidence.object_id,
    object_kind: "memory_entry" as const,
    schema_version: 1,
    lifecycle_state: evidence.lifecycle_state,
    created_at: evidence.created_at,
    updated_at: evidence.updated_at,
    created_by: evidence.created_by,
    dimension: "episode" as const,
    source_kind: "compiler" as const,
    formation_kind: "derived" as const,
    scope_class: "project" as const,
    content: createBoundedNonMemoryPreview(recallText),
    domain_tags: Object.freeze(["source_evidence"]),
    evidence_refs: Object.freeze([evidence.object_id]),
    workspace_id: evidence.workspace_id,
    run_id: evidence.run_id,
    surface_id: evidence.surface_id,
    storage_tier: "hot" as const,
    activation_score: normalizedRank,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  });
}

export function resolveDirectEvidenceRecallText(
  evidence: Readonly<EvidenceCapsule>
): string {
  return evidence.excerpt ?? evidence.gist;
}
