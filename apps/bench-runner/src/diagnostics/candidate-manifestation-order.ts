import type { RecallOriginPlane } from "@do-soul/alaya-protocol";

const ORIGIN_PLANE_ORDER: Readonly<Record<RecallOriginPlane, number>> =
  Object.freeze({ workspace_local: 0, global: 1 });

export interface CandidateManifestationOrderKey {
  readonly finalRank: number | null;
  readonly fusedRank: number | null;
  readonly originPlane: RecallOriginPlane;
  readonly candidateKey: string;
}

export function isPreferredCandidateManifestation(
  candidate: CandidateManifestationOrderKey,
  existing: CandidateManifestationOrderKey
): boolean {
  return compareCandidateManifestations(candidate, existing) < 0;
}

export function compareCandidateManifestations(
  left: CandidateManifestationOrderKey,
  right: CandidateManifestationOrderKey
): number {
  const finalOrder = compareNullableRank(left.finalRank, right.finalRank);
  if (finalOrder !== 0) return finalOrder;
  const fusedOrder = compareNullableRank(left.fusedRank, right.fusedRank);
  if (fusedOrder !== 0) return fusedOrder;
  const planeOrder = ORIGIN_PLANE_ORDER[left.originPlane] -
    ORIGIN_PLANE_ORDER[right.originPlane];
  if (planeOrder !== 0) return planeOrder;
  return compareCodeUnits(left.candidateKey, right.candidateKey);
}

function compareNullableRank(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
