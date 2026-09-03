import type { SemanticArtifact } from "./contract.js";
import type { VerifiedSemanticArtifactAdmission } from "./admit.js";

const legacyAdmissions = new WeakMap<object, SemanticArtifact>();

export function sealLegacySemanticArtifactAdmission(
  handle: VerifiedSemanticArtifactAdmission,
  artifact: SemanticArtifact
): void {
  legacyAdmissions.set(handle, artifact);
}

export function unwrapLegacySemanticArtifactAdmission(
  handle: VerifiedSemanticArtifactAdmission
): SemanticArtifact | undefined {
  return legacyAdmissions.get(handle);
}
