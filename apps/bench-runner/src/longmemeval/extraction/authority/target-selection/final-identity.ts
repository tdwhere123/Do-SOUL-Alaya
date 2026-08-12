import type { ExtractionCacheCompatibilityDecision } from
  "../../cache-audit/compatibility.js";
import type { ExtractionAuthorityObservation } from "../receipt.js";
import type { ExtractionTargetFinalIdentity } from "./receipt.js";

export function assertAuditFinalIdentity(
  auditDecision: ExtractionCacheCompatibilityDecision,
  observation: ExtractionAuthorityObservation
): void {
  const current = extractionTargetFinalIdentity(observation);
  const raw = auditDecision.raw.final;
  if (raw.datasetRevision !== current.dataset_revision_sha256 ||
      raw.model !== current.model ||
      auditDecision.projection.final.modelFamily !== current.model_family ||
      raw.requestProfile !== current.request_profile || raw.providerUrl !== current.provider_url ||
      raw.systemPromptSha256 !== current.system_prompt_sha256 ||
      raw.cacheKeyAlgorithm !== current.cache_key_algorithm) {
    throw new Error("extraction target selection audit final identity does not match the live target");
  }
}

export function assertFinalIdentity(
  expected: ExtractionTargetFinalIdentity,
  observation: ExtractionAuthorityObservation
): void {
  const current = extractionTargetFinalIdentity(observation);
  if (expected.revision !== current.revision && observation.dataset.variant === "longmemeval_s" &&
      observation.dataset.windowOffset === 0 && observation.dataset.windowLimit === 500) {
    assertContinuationFinalIdentity(expected, observation);
    return;
  }
  if (expected.revision !== current.revision || !sameLogicalIdentity(expected, current)) {
    throw new Error("extraction target selection final identity drifted");
  }
}

export function assertContinuationFinalIdentity(
  predecessor: ExtractionTargetFinalIdentity,
  observation: ExtractionAuthorityObservation
): void {
  const current = extractionTargetFinalIdentity(observation);
  if (predecessor.revision === current.revision || !sameLogicalIdentity(predecessor, current)) {
    throw new Error("same-root continuation target identity is not a revision-only successor");
  }
}

export function assertMaterializedSuccessorFinalIdentity(
  predecessor: ExtractionTargetFinalIdentity,
  observation: ExtractionAuthorityObservation
): void {
  if (!sameLogicalIdentity(predecessor, extractionTargetFinalIdentity(observation))) {
    throw new Error("materialized successor target identity drifted");
  }
}

export function extractionTargetFinalIdentity(
  observation: ExtractionAuthorityObservation
): ExtractionTargetFinalIdentity {
  return Object.freeze({
    revision: observation.revision,
    dataset_variant: observation.dataset.variant,
    dataset_revision_sha256: observation.dataset.revisionSha256,
    model: observation.extraction.model,
    model_family: observation.extraction.modelFamily,
    request_profile: observation.extraction.requestProfile,
    provider_url: observation.extraction.providerUrl,
    system_prompt_sha256: observation.extraction.systemPromptSha256,
    cache_key_algorithm: observation.extraction.cacheKeyAlgorithm
  });
}

function sameLogicalIdentity(
  left: ExtractionTargetFinalIdentity,
  right: ExtractionTargetFinalIdentity
): boolean {
  return left.dataset_variant === right.dataset_variant &&
    left.dataset_revision_sha256 === right.dataset_revision_sha256 &&
    left.model === right.model && left.model_family === right.model_family &&
    left.request_profile === right.request_profile && left.provider_url === right.provider_url &&
    left.system_prompt_sha256 === right.system_prompt_sha256 &&
    left.cache_key_algorithm === right.cache_key_algorithm;
}
