import { compareText } from "../../../shared/compare-text.js";
import { ShadowContractError } from "../contract-primitives.js";
import {
  createPsiCycleFailure,
  type PsiQuery,
  type ShadowPsiCycleFailure
} from "../dominance-contract.js";
import {
  parseFrontierReceipt,
  SHADOW_FRONTIER_OPERATOR_ID,
  type ShadowFrontierReceipt
} from "./frontiers.js";

export type ShadowPsiFn = PsiQuery;

export type ShadowFrontierPeelResult =
  | ShadowFrontierReceipt
  | ShadowPsiCycleFailure;

// Capture spies peelUndominated; observation peel must not share that export.
export function peelUndominated(
  eligible: readonly string[],
  psi: ShadowPsiFn
): ShadowFrontierPeelResult {
  return peelLayers(eligible, psi);
}

export function peelPointwiseObservationFrontiers(
  eligible: readonly string[],
  psi: ShadowPsiFn
): ShadowFrontierPeelResult {
  return peelLayers(eligible, psi);
}

export function isPsiCycleFailure(
  result: ShadowFrontierPeelResult
): result is ShadowPsiCycleFailure {
  return "kind" in result && result.kind === "psi_cycle_contract_failure";
}

function peelLayers(
  eligible: readonly string[],
  psi: ShadowPsiFn
): ShadowFrontierPeelResult {
  const remaining = uniqueEligible(eligible);
  const layers: { index: number; member_keys: readonly string[] }[] = [];
  let rest = remaining;
  let index = 1;
  while (rest.length > 0) {
    const layer = undominatedIn(rest, psi);
    if (layer.length === 0) return cycleFailure();
    layers.push({
      index,
      member_keys: Object.freeze([...layer].sort(compareText))
    });
    const peeled = new Set(layer);
    rest = rest.filter((key) => !peeled.has(key));
    index += 1;
  }
  return parseFrontierReceipt({
    schema_version: 1,
    operator_id: SHADOW_FRONTIER_OPERATOR_ID,
    layers
  });
}

function uniqueEligible(eligible: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const key of eligible) {
    if (key.length === 0) {
      throw new ShadowContractError("eligible key must be nonempty");
    }
    if (seen.has(key)) {
      throw new ShadowContractError("eligible keys must be unique");
    }
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

function undominatedIn(remaining: readonly string[], psi: ShadowPsiFn): string[] {
  const layer: string[] = [];
  for (const candidate of remaining) {
    if (!isDominatedIn(candidate, remaining, psi)) layer.push(candidate);
  }
  return layer;
}

function isDominatedIn(
  candidate: string,
  remaining: readonly string[],
  psi: ShadowPsiFn
): boolean {
  for (const other of remaining) {
    if (psi(other, candidate)) return true;
  }
  return false;
}

function cycleFailure(): ShadowPsiCycleFailure {
  return createPsiCycleFailure();
}
