import { getPathAnchorBackingObjectId, isPathRecallEligible, type ManifestationState, type PathRelation } from "@do-soul/alaya-protocol";
import { clampManifestationByGovernance, memoryGovernanceCeiling, type PathGovernanceContribution } from "../../relations/path-relations/path-manifestation-policy.js";

export function governanceManifestationCeilings(paths: readonly Readonly<PathRelation>[]): ReadonlyMap<string, ManifestationState> {
  const contributions = new Map<string, PathGovernanceContribution[]>();
  for (const path of paths) {
    if (!isPathRecallEligible(path)) continue;
    const target = getPathAnchorBackingObjectId(path.anchors.target_anchor);
    const existing = contributions.get(target) ?? [];
    existing.push({ governance_class: path.legitimacy.governance_class, evidence_basis: path.legitimacy.evidence_basis });
    contributions.set(target, existing);
  }
  return new Map([...contributions].map(([id, rows]) => [id, memoryGovernanceCeiling(rows)]));
}

export function governanceManifestationFor(objectId: string, ceilings: ReadonlyMap<string, ManifestationState>, complete: boolean): ManifestationState {
  return complete ? clampManifestationByGovernance("excerpt", ceilings.get(objectId) ?? "full_eligible") : "hint";
}
