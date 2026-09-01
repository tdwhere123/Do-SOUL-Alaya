import type { ChannelClosureResult } from "../closure/contract.js";
import type { QueryCompiledGammaV1 } from "../gamma/contract.js";
import type { LiveQueryProofAuthority } from "../live-query-proof-authority.js";
import type { QueryProofDecideWorldV1 } from "./decide.js";

export function hasUnresolvedSemantic(world: QueryProofDecideWorldV1): boolean {
  const semantic = uniqueSemanticByCandidate(world);
  if (semantic === null) return true;
  return world.candidates.some((row) => semantic.get(row.candidate_key) === "unresolved");
}

export function hasUnknownGammaStanding(compiled: QueryCompiledGammaV1): boolean {
  return compiled.standings.some((standing) =>
    standing.coverage === "unknown" || standing.independence === "unknown");
}

export function prefixAllFeasible(
  world: QueryProofDecideWorldV1,
  prefix: readonly string[]
): boolean {
  const semantic = uniqueSemanticByCandidate(world);
  if (semantic === null) return false;
  return prefix.every((key) => semantic.get(key) === "feasible");
}

export function sealObligationsCovered(
  compiled: QueryCompiledGammaV1,
  closures: readonly ChannelClosureResult[],
  authority: LiveQueryProofAuthority
): boolean {
  if (compiled.seal_obligations.length === 0) return true;
  const snapshot = authority.snapshot_vector.vector_digest;
  return compiled.seal_obligations.every((obligation) =>
    closures.some((closure) => coversSealObligation(
      obligation.target, closure, compiled, snapshot)));
}

function uniqueSemanticByCandidate(
  world: QueryProofDecideWorldV1
): Map<string, QueryCompiledGammaV1["semantic_feasibility"][number]["semantic"]> | null {
  const semantic = new Map<
    string,
    QueryCompiledGammaV1["semantic_feasibility"][number]["semantic"]
  >();
  for (const row of world.compiled.semantic_feasibility) {
    if (semantic.has(row.candidate_key)) return null;
    semantic.set(row.candidate_key, row.semantic);
  }
  return semantic;
}

function coversSealObligation(
  target: string,
  closure: ChannelClosureResult,
  compiled: QueryCompiledGammaV1,
  snapshot: string
): boolean {
  if (closure.status !== "exact_closed" || closure.remaining_effects.length !== 0 ||
      closure.snapshot_digest !== snapshot) return false;
  if (closure.query_digest !== compiled.compilation_digest &&
      closure.query_digest !== compiled.query_digest) return false;
  return closure.completeness_refs.some((ref) =>
    ref.coordinate_id === target || ref.domain_id === target);
}
