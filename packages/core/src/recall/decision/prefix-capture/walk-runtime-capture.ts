import { compareText } from "../../../shared/compare-text.js";
import { captureData } from "../capture-data.js";
import type {
  ShadowCaptureWalkCandidate,
  ShadowCaptureWalkInput
} from "./walk.js";

export type ShadowWalkRuntimeManifestV1 = Readonly<{
  readonly candidates: readonly Omit<ShadowCaptureWalkCandidate, "utility">[];
  readonly psi_edges: readonly (readonly [string, string])[];
  readonly token_budget: number;
  readonly per_dimension_limits: Readonly<Record<string, number>> | null;
  readonly unresolved_tradeoff_pairs: readonly (readonly [string, string])[];
}>;

export function captureWalkRuntimeInput(input: ShadowCaptureWalkInput): Readonly<{
  readonly input: ShadowCaptureWalkInput;
  readonly manifest: ShadowWalkRuntimeManifestV1;
}> {
  const captured = captureData({
    candidates: input.candidates,
    token_budget: input.token_budget,
    per_dimension_limits: input.per_dimension_limits,
    obligation_universe: input.obligation_universe
  });
  const keys = captured.candidates.map(({ candidate_key }) => candidate_key);
  const psiEdges = directedEdges(keys, input.psi);
  const unresolvedPairs = undirectedEdges(keys, input.unresolved_tradeoff);
  const psiSet = new Set(psiEdges.map(pairKey));
  const unresolvedSet = new Set(unresolvedPairs.map(pairKey));
  const runtimeInput = Object.freeze({
    candidates: captured.candidates,
    psi: (left: string, right: string) => psiSet.has(pairKey([left, right])),
    token_budget: captured.token_budget,
    per_dimension_limits: captured.per_dimension_limits,
    unresolved_tradeoff: (left: string, right: string) =>
      unresolvedSet.has(pairKey(normalizePair(left, right))),
    ...(captured.obligation_universe === undefined
      ? {}
      : { obligation_universe: captured.obligation_universe }),
    ...(input.utility_transfer === undefined
      ? {}
      : { utility_transfer: input.utility_transfer })
  }) satisfies ShadowCaptureWalkInput;
  const manifest = captureData({
    candidates: captured.candidates.map(({ utility: _utility, ...candidate }) => candidate),
    psi_edges: psiEdges,
    token_budget: captured.token_budget,
    per_dimension_limits: captured.per_dimension_limits,
    unresolved_tradeoff_pairs: unresolvedPairs
  });
  return Object.freeze({ input: runtimeInput, manifest });
}

function directedEdges(
  keys: readonly string[],
  query: (left: string, right: string) => boolean
): readonly (readonly [string, string])[] {
  return Object.freeze(keys.flatMap((left) => keys.flatMap((right) =>
    left !== right && query(left, right)
      ? [Object.freeze([left, right] as const)]
      : [])).sort(comparePairs));
}

function undirectedEdges(
  keys: readonly string[],
  query: ((left: string, right: string) => boolean) | undefined
): readonly (readonly [string, string])[] {
  if (query === undefined) return Object.freeze([]);
  return Object.freeze(keys.flatMap((left, index) => keys.slice(index + 1).flatMap((right) =>
    query(left, right) || query(right, left)
      ? [normalizePair(left, right)]
      : [])).sort(comparePairs));
}

function normalizePair(left: string, right: string): readonly [string, string] {
  return Object.freeze(compareText(left, right) <= 0 ? [left, right] : [right, left]);
}

function pairKey(pair: readonly [string, string]): string {
  return `${pair[0]}\0${pair[1]}`;
}

function comparePairs(
  left: readonly [string, string],
  right: readonly [string, string]
): number {
  return compareText(pairKey(left), pairKey(right));
}
