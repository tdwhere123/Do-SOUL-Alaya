import type { SemanticArtifact } from "./contract.js";

export interface VerifiedSemanticArtifactAdmission {
  readonly semanticKey: string;
  readonly state: "provider_backed" | "quarantined";
}

const verifiedAdmissions = new WeakMap<object, SemanticArtifact>();

export function sealVerifiedSemanticArtifactAdmission(
  artifact: SemanticArtifact
): VerifiedSemanticArtifactAdmission {
  if (artifact.admission_state !== "provider_backed" &&
      artifact.admission_state !== "quarantined") {
    throw new Error("verified admission cannot seal this artifact state");
  }
  const handle = Object.freeze({
    semanticKey: artifact.semantic_key,
    state: artifact.admission_state
  });
  verifiedAdmissions.set(handle, artifact);
  return handle;
}

export function unwrapVerifiedSemanticArtifactAdmission(
  handle: VerifiedSemanticArtifactAdmission
): SemanticArtifact {
  const artifact = verifiedAdmissions.get(handle);
  if (artifact === undefined || artifact.semantic_key !== handle.semanticKey ||
      artifact.admission_state !== handle.state) {
    throw new Error("semantic artifact publication requires a verified admission handle");
  }
  return artifact;
}
