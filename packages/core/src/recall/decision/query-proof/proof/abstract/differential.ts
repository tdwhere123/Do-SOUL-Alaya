import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from
  "../../../../field/field-identity.js";
import {
  captureVerifiedLiveClosureAuthority
} from "../../closure/live-authority-binding.js";
import type { FiniteDecisionOracleResult } from "../oracle/contract.js";
import {
  assertFiniteOracleExhaustive
} from "../oracle/oracle.js";
import {
  abstractResultIdentity,
  verifyAbstractProofKernelResult,
  type AbstractProofKernelInput,
  type AbstractProofKernelResult,
  type FiniteOracleDifferentialCertificate
} from "./contract.js";
import {
  evaluateAbstractProofKernel,
  evaluateAbstractSingletonCandidate
} from "./kernel.js";

export type AbstractOracleComparison = Readonly<{
  readonly false_singleton: boolean;
  readonly missing_concrete_outcome_digests: readonly string[];
}>;

export function compareAbstractProofToOracle(
  input: AbstractProofKernelInput,
  proof: AbstractProofKernelResult,
  oracle: FiniteDecisionOracleResult
): AbstractOracleComparison {
  const captured = captureVerifiedLiveClosureAuthority(input.live_authority);
  const stableInput = Object.freeze({ ...input, live_authority: captured.authority });
  assertExactOracle(stableInput, oracle);
  verifyAbstractProofKernelResult(proof, stableInput,
    proof.status === "PROVED_SINGLETON" ? oracle : undefined);
  const concrete = oracle.outcomes.map(({ trace_digest }) => trace_digest);
  if (proof.status === "PROVED_SINGLETON") {
    return Object.freeze({
      false_singleton: concrete.length !== 1 ||
        concrete[0] !== proof.outcome.trace_digest,
      missing_concrete_outcome_digests: Object.freeze(concrete.filter((digest) =>
        digest !== proof.outcome.trace_digest).sort(compareText))
    });
  }
  if (proof.status !== "OPEN" || proof.possible_outcomes.length === 0) {
    return emptyComparison();
  }
  const possible = new Set(proof.possible_outcomes.map(({ trace_digest }) =>
    trace_digest));
  return Object.freeze({
    false_singleton: false,
    missing_concrete_outcome_digests: Object.freeze(concrete.filter((digest) =>
      !possible.has(digest)).sort(compareText))
  });
}

export function certifyAbstractSingletonWithFiniteOracle(
  input: AbstractProofKernelInput,
  oracle: FiniteDecisionOracleResult
): AbstractProofKernelResult {
  const evaluation = evaluateAbstractSingletonCandidate(input);
  if (evaluation.kind === "result") return evaluation.result;
  assertExactOracle(evaluation.input, oracle);
  if (oracle.outcomes.length !== 1 ||
      oracle.outcomes[0]!.trace_digest !== evaluation.outcome.trace_digest) {
    return evaluateAbstractProofKernel(input);
  }
  const identity = abstractResultIdentity(evaluation.input, evaluation.live_binding);
  const certificate = sealDifferentialCertificate({
    schema_version: 1,
    operator_id: "finite_oracle_differential_certificate_v1",
    authority_digest: identity.authority_digest,
    query_digest: identity.query_digest,
    snapshot_digest: identity.snapshot_digest,
    principal_digest: identity.principal_digest,
    fixture_digest: identity.fixture_digest,
    manifest_digest: identity.manifest_digest,
    k_max: identity.k_max,
    concrete_operator_id: identity.concrete_operator_id,
    abstract_operator_id: identity.decision_operator_id,
    oracle_result_digest: oracle.result_digest,
    abstract_premise_digest: identity.premise_digest,
    outcome_trace_digest: evaluation.outcome.trace_digest,
    false_singleton: false,
    missing_concrete_outcome_digests: Object.freeze([])
  });
  const proved = sealCertifiedResult({
    ...identity,
    status: "PROVED_SINGLETON",
    outcome: evaluation.outcome,
    differential_certificate: certificate
  });
  verifyAbstractProofKernelResult(proved, evaluation.input, oracle);
  return proved;
}

function sealCertifiedResult(body: Omit<Extract<
  AbstractProofKernelResult,
  { status: "PROVED_SINGLETON" }
>, "proof_digest">): Extract<AbstractProofKernelResult, { status: "PROVED_SINGLETON" }> {
  return Object.freeze({ ...body, proof_digest: digestRecallFieldIdentity(body) });
}

function assertExactOracle(
  input: AbstractProofKernelInput,
  oracle: FiniteDecisionOracleResult
): void {
  assertFiniteOracleExhaustive({
    authority: input.live_authority,
    fixture: input.fixture,
    operator: input.concrete_operator,
    result: oracle
  });
}

function sealDifferentialCertificate(body: Omit<
  FiniteOracleDifferentialCertificate,
  "certificate_digest"
>): FiniteOracleDifferentialCertificate {
  return Object.freeze({
    ...body,
    certificate_digest: digestRecallFieldIdentity(body)
  });
}

function emptyComparison(): AbstractOracleComparison {
  return Object.freeze({
    false_singleton: false,
    missing_concrete_outcome_digests: Object.freeze([])
  });
}
