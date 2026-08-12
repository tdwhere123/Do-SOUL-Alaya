import {
  hasGardenSourceTurnFallbackAnyReceiptFormat,
  parseVerifiedUserAssertionSourceHash
} from "@do-soul/alaya-protocol";

export interface EvidenceRecallAuthority {
  readonly workspaceId: string;
  readonly lifecycleState: string;
  readonly createdBy: string;
  readonly evidenceKind: string;
  readonly evidenceHealthState: string;
  readonly artifactRef: string | null;
  readonly sourceHash: string | null;
}

export function hasDirectEvidenceRecallAuthority(
  evidence: Readonly<EvidenceRecallAuthority>,
  workspaceId: string
): boolean {
  return hasEvidenceRecallEnvelope(evidence, workspaceId) &&
    hasGardenSourceTurnFallbackAnyReceiptFormat({
      artifact_ref: evidence.artifactRef,
      source_hash: evidence.sourceHash
    });
}

export function hasEvidenceDocumentEmbeddingAuthority(
  evidence: Readonly<EvidenceRecallAuthority> & { readonly documentIdentity: string },
  workspaceId: string
): boolean {
  if (!hasEvidenceRecallEnvelope(evidence, workspaceId)) return false;
  return hasGardenSourceTurnFallbackAnyReceiptFormat({
    artifact_ref: evidence.artifactRef,
    source_hash: evidence.sourceHash
  }) || (
    evidence.documentIdentity.startsWith("fact_key:") &&
    parseVerifiedUserAssertionSourceHash(evidence.sourceHash) !== null
  );
}

function hasEvidenceRecallEnvelope(
  evidence: Readonly<EvidenceRecallAuthority>,
  workspaceId: string
): boolean {
  return evidence.workspaceId === workspaceId &&
    evidence.lifecycleState === "active" &&
    evidence.createdBy === "garden_compile" &&
    evidence.evidenceHealthState === "verified" &&
    evidence.evidenceKind === "conversation_excerpt";
}
