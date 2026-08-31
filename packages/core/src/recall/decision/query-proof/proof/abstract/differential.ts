import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from
  "../../../../field/field-identity.js";
import {
  captureData,
  captureVerifiedLiveClosureAuthority
} from "../../closure/live-authority-binding.js";
import type { FiniteDecisionOracleResult } from "../oracle/contract.js";
import {
  assertFiniteOracleExhaustive
} from "../oracle/oracle.js";
import {
  abstractResultIdentity,
  captureAbstractProofKernelInput,
  sealAbstractRefusalResult,
  verifyAbstractProofKernelResult,
  type AbstractProofKernelInput,
  type AbstractProofKernelResult,
  type FiniteOracleDifferentialCertificate
} from "./contract.js";
import {
  evaluateAbstractSingletonCandidate,
  type KernelEvaluation
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
  const capturedInput = captureAbstractProofKernelInput(input);
  const captured = captureVerifiedLiveClosureAuthority(capturedInput.live_authority);
  const stableInput = Object.freeze({ ...capturedInput,
    live_authority: captured.authority });
  const stableOracle = assertExactOracle(stableInput, oracle);
  const capturedProof = captureData(proof);
  const verified = verifyAbstractProofKernelResult(
    capturedProof,
    stableInput,
    capturedProof.status === "PROVED_SINGLETON" ? stableOracle : undefined
  );
  const concrete = stableOracle.outcomes.map(({ trace_digest }) => trace_digest);
  if (verified.status === "PROVED_SINGLETON") {
    return Object.freeze({
      false_singleton: concrete.length !== 1 ||
        concrete[0] !== verified.outcome.trace_digest,
      missing_concrete_outcome_digests: Object.freeze(concrete.filter((digest) =>
        digest !== verified.outcome.trace_digest).sort(compareText))
    });
  }
  const possible = new Set(verified.status === "OPEN"
    ? verified.possible_outcomes.map(({ trace_digest }) => trace_digest)
    : []);
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
  const oracleSnapshot = assertExactOracle(evaluation.input, oracle);
  if (oracleSnapshot.outcomes.length !== 1 ||
      oracleSnapshot.outcomes[0]!.trace_digest !== evaluation.outcome.trace_digest) {
    return unsupportedEvaluation(evaluation,
      "abstract operator under-approximates finite oracle outcomes");
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
    oracle_result_digest: oracleSnapshot.result_digest,
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
  return verifyAbstractProofKernelResult(proved, evaluation.input, oracleSnapshot);
}

function sealCertifiedResult(body: Omit<Extract<
  AbstractProofKernelResult,
  { status: "PROVED_SINGLETON" }
>, "proof_digest">): Extract<AbstractProofKernelResult, { status: "PROVED_SINGLETON" }> {
  return Object.freeze({ ...body, proof_digest: digestRecallFieldIdentity(body) });
}

function unsupportedEvaluation(
  evaluation: Extract<KernelEvaluation, { kind: "singleton_candidate" }>,
  reason: string
): AbstractProofKernelResult {
  return sealAbstractRefusalResult({
    ...abstractResultIdentity(evaluation.input, evaluation.live_binding),
    status: "UNSUPPORTED" as const,
    reason
  });
}

function assertExactOracle(
  input: AbstractProofKernelInput,
  oracle: FiniteDecisionOracleResult
): FiniteDecisionOracleResult {
  return assertFiniteOracleExhaustive({
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
