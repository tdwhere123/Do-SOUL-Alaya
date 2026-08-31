import { compareText } from "../../../../../shared/compare-text.js";
import type { FiniteDecisionOracleResult } from "../oracle/contract.js";
import type { AbstractProofKernelResult } from "./contract.js";

export type AbstractOracleComparison = Readonly<{
  readonly false_singleton: boolean;
  readonly missing_concrete_outcome_digests: readonly string[];
}>;

export function compareAbstractProofToOracle(
  proof: AbstractProofKernelResult,
  oracle: FiniteDecisionOracleResult
): AbstractOracleComparison {
  if (proof.status === "PROVED_SINGLETON") {
    const concrete = oracle.outcomes.map(({ trace_digest }) => trace_digest);
    return Object.freeze({
      false_singleton: concrete.length !== 1 ||
        concrete[0] !== proof.outcome.trace_digest,
      missing_concrete_outcome_digests: Object.freeze(concrete.filter((digest) =>
        digest !== proof.outcome.trace_digest).sort(compareText))
    });
  }
  if (proof.status !== "OPEN" || proof.possible_outcomes.length === 0) {
    return Object.freeze({
      false_singleton: false,
      missing_concrete_outcome_digests: Object.freeze([])
    });
  }
  const abstract = new Set(proof.possible_outcomes.map(({ trace_digest }) => trace_digest));
  return Object.freeze({
    false_singleton: false,
    missing_concrete_outcome_digests: Object.freeze(oracle.outcomes
      .map(({ trace_digest }) => trace_digest)
      .filter((digest) => !abstract.has(digest))
      .sort(compareText))
  });
}
