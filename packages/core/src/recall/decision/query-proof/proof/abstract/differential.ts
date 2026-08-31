import { compareText } from "../../../../../shared/compare-text.js";
import type { FiniteDecisionOracleResult } from "../oracle/contract.js";
import { assertFiniteOracleExhaustive } from "../oracle/oracle.js";
import {
  readFiniteTransferAuthority,
  type FiniteTransferAuthority
} from "../oracle/transfer-authority.js";
import {
  verifyAbstractProofKernelResult,
  type AbstractProofKernelResult
} from "./contract.js";

export type AbstractOracleComparison = Readonly<{
  readonly false_singleton: boolean;
  readonly missing_concrete_outcome_digests: readonly string[];
}>;

export function compareAbstractProofToOracle(
  proof: AbstractProofKernelResult,
  oracle: FiniteDecisionOracleResult,
  authority: FiniteTransferAuthority
): AbstractOracleComparison {
  const transfer = readFiniteTransferAuthority(authority);
  if (oracle.fixture_digest !== transfer.fixture_digest ||
      oracle.transfer_digest !== transfer.transfer_digest ||
      oracle.manifest_digest !== transfer.manifest_digest ||
      oracle.decision_operator_id !== transfer.concrete_operator.operator_id ||
      oracle.abstract_operator_id !== transfer.abstract_operator.operator_id) {
    throw new Error("oracle does not belong to the supplied transfer authority");
  }
  assertFiniteOracleExhaustive(transfer.fixture, oracle, authority);
  verifyAbstractProofKernelResult(proof);
  if (proof.fixture_digest !== oracle.fixture_digest ||
      proof.transfer_digest !== oracle.transfer_digest ||
      proof.manifest_digest !== oracle.manifest_digest ||
      proof.concrete_operator_id !== oracle.decision_operator_id ||
      proof.decision_operator_id !== oracle.abstract_operator_id ||
      proof.query_digest !== transfer.query_digest ||
      proof.snapshot_digest !== transfer.fixture.snapshot_digest ||
      proof.principal_digest !== transfer.principal_digest) {
    throw new Error("abstract proof and oracle transfer identities do not match");
  }
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
