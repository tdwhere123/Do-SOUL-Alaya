import type { SelectGammaFormulaCandidate } from "../types.js";
import {
  BINDING_COVER_RHO_CONTENT,
  BINDING_COVER_RHO_LINEAGE,
  type BindingCoverState
} from "./types.js";

export function bindingCoverRho(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState,
  contentKey: string | undefined
): number {
  return lineageRho(candidate, state) + contentRho(contentKey, state);
}

export function acceptBindingCoverRho(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState,
  contentKey: string | undefined
): void {
  if (candidate.lineage.status === "available") {
    state.lineageKeys.add(candidate.lineage.key);
  }
  if (contentKey !== undefined) {
    state.contentKeys.add(contentKey);
  }
}

export function boundRedundancy(rho: number, positiveGain: number): number {
  // Cap so proof evaluation cannot observe negative gain.
  if (!Number.isFinite(rho) || rho <= 0) return 0;
  return Math.min(rho, Math.max(0, positiveGain));
}

function lineageRho(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState
): number {
  return candidate.lineage.status === "available" &&
    state.lineageKeys.has(candidate.lineage.key)
    ? BINDING_COVER_RHO_LINEAGE
    : 0;
}

function contentRho(
  contentKey: string | undefined,
  state: BindingCoverState
): number {
  return contentKey !== undefined && state.contentKeys.has(contentKey)
    ? BINDING_COVER_RHO_CONTENT
    : 0;
}
