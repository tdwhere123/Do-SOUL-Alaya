import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { SHADOW_CAPTURE_OPERATOR_ID } from "../../prefix-capture/identity.js";
import { captureVerifiedLiveClosureAuthority } from
  "../closure/live-authority-binding.js";
import type { LiveQueryProofAuthority } from "../live-query-proof-authority.js";
import type { QueryCompiledGammaV1 } from "../gamma/contract.js";
import { createQueryCompiledWalkTransfer } from "../gamma/walk-binding.js";
import {
  certifyAbstractSingletonWithFiniteOracle
} from "../proof/abstract/differential.js";
import type {
  AbstractDecisionOperator,
  AbstractKernelLimits,
  AbstractProofKernelInput,
} from "../proof/abstract/contract.js";
import {
  enumerateFiniteDecisionOracle
} from "../proof/oracle/oracle.js";
import {
  normalizeDecisionTrace,
  type FiniteDecisionOperator,
  type FiniteDecisionOracleResult,
  type FiniteOracleFixture
} from "../proof/oracle/contract.js";
import type { ChannelClosureResult } from "../closure/contract.js";
import {
  DECISION_STABILITY_SEAL_OPERATOR_ID,
  digestDecisionContract,
  QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
  type DecisionStabilitySealV1,
  type SealCheckerResultV1
} from "./contract.js";
import {
  runQueryProofDecideQ,
  type QueryProofDecideWorldV1
} from "./decide.js";

export type SealCheckerInputV1 = Readonly<{
  readonly live_authority: LiveQueryProofAuthority;
  readonly fixture: FiniteOracleFixture;
  readonly compiled: QueryCompiledGammaV1;
  readonly world: QueryProofDecideWorldV1;
  readonly concrete_operator: FiniteDecisionOperator;
  readonly abstract_operator: AbstractDecisionOperator;
  readonly closures: readonly ChannelClosureResult[];
  readonly coordinates: AbstractProofKernelInput["coordinates"];
  readonly limits: AbstractKernelLimits;
  readonly k_max: number;
}>;

export function checkDecisionStability(
  input: SealCheckerInputV1
): SealCheckerResultV1 {
  const digest = contractDigest(input.world);
  if (input.concrete_operator.operator_id !== QUERY_PROOF_FINAL_DECISION_OPERATOR_ID ||
      input.abstract_operator.operator_id !== QUERY_PROOF_FINAL_DECISION_OPERATOR_ID) {
    return unsupported(digest, "final Decide_Q operator identity mismatch");
  }
  const identityReason = compiledIdentityMismatch(input);
  if (identityReason !== null) return unsupported(digest, identityReason);
  let captured;
  try {
    captured = captureVerifiedLiveClosureAuthority(input.live_authority);
  } catch (error) {
    return unsupported(digest, messageOf(error));
  }
  let oracle: FiniteDecisionOracleResult;
  try {
    oracle = enumerateFiniteDecisionOracle({
      authority: captured.authority,
      fixture: input.fixture,
      operator: input.concrete_operator
    });
  } catch (error) {
    return unsupported(digest, messageOf(error));
  }
  if (oracle.decision_operator_id !== QUERY_PROOF_FINAL_DECISION_OPERATOR_ID) {
    return unsupported(digest, "oracle operator is not the bound final decision operator");
  }
  let decided;
  try {
    decided = runQueryProofDecideQ(input.world, input.k_max);
  } catch (error) {
    return unsupported(digest, messageOf(error));
  }
  if (decided.walk.operator_id !== SHADOW_CAPTURE_OPERATOR_ID) {
    return unsupported(digest, "walk operator identity mismatch");
  }
  if (decided.decision_contract_digest !== digest) {
    return unsupported(digest, "walk decision-contract digest mismatch");
  }
  if (decided.unresolved_boundary_tradeoff) {
    return open(digest, "unresolved trade-off at a selected boundary");
  }
  if (hasUnresolvedSemantic(input.world)) {
    return open(digest, "unresolved semantic feasibility remains");
  }
  if (!prefixAllFeasible(input.world, decided.prefix)) {
    return open(digest, "selected prefix is not compiled-feasible");
  }
  if (!sealObligationsCovered(input.world.compiled, input.closures, captured.authority)) {
    return open(digest, "seal obligations are not covered by certified closures");
  }
  if (oracle.outcomes.length !== 1) {
    return open(digest, "represented refinements do not preserve one prefix/binding/reason");
  }
  return certifyStableOutcome(input, captured.authority, digest, oracle, decided);
}

function certifyStableOutcome(
  input: SealCheckerInputV1,
  authority: LiveQueryProofAuthority,
  digest: RecallFieldDigest,
  oracle: FiniteDecisionOracleResult,
  decided: ReturnType<typeof runQueryProofDecideQ>
): SealCheckerResultV1 {
  const kernelInput = Object.freeze({
    live_authority: authority,
    fixture: input.fixture,
    concrete_operator: input.concrete_operator,
    k_max: input.k_max,
    closures: input.closures,
    coordinates: input.coordinates,
    limits: input.limits,
    operator: input.abstract_operator
  });
  const proved = certifyAbstractSingletonWithFiniteOracle(kernelInput, oracle);
  if (proved.status === "CONFLICT") {
    return Object.freeze({
      status: "CONFLICT" as const,
      decision_contract_digest: digest,
      reason: proved.reason
    });
  }
  if (proved.status === "UNSUPPORTED") {
    return unsupported(digest, proved.reason);
  }
  if (proved.status !== "PROVED_SINGLETON") {
    return Object.freeze({
      status: "UNCERTIFIED_OPEN" as const,
      decision_contract_digest: digest,
      reason: proved.reason,
      requested_refinements: proved.requested_refinements
    });
  }
  const outcome = oracle.outcomes[0]!;
  const walkedTrace = normalizeDecisionTrace(decided.trace, input.k_max);
  if (outcome.trace_digest !== proved.outcome.trace_digest ||
      outcome.trace_digest !== walkedTrace.trace_digest) {
    return open(digest, "oracle, abstract proof, and walk traces are not the same singleton");
  }
  return Object.freeze({
    status: "CERTIFIED_STABLE" as const,
    decision_contract_digest: digest,
    seal: mintSeal(digest, input, authority, outcome, decided.walk.operator_id)
  });
}

function compiledIdentityMismatch(input: SealCheckerInputV1): string | null {
  const compiled = input.compiled;
  const world = input.world.compiled;
  if (compiled.gamma_digest !== world.gamma_digest) {
    return "compiled Gamma digest does not match Decide_Q world";
  }
  if (compiled.query_digest !== world.query_digest) {
    return "compiled query digest does not match Decide_Q world";
  }
  if (compiled.compilation_digest !== world.compilation_digest) {
    return "compiled compilation digest does not match Decide_Q world";
  }
  return null;
}

function contractDigest(world: QueryProofDecideWorldV1): RecallFieldDigest {
  const transfer = createQueryCompiledWalkTransfer(world.compiled);
  return digestDecisionContract(world.compiled, transfer.contract_digest);
}

function hasUnresolvedSemantic(world: QueryProofDecideWorldV1): boolean {
  const present = new Set(world.candidates.map((row) => row.candidate_key));
  return world.compiled.semantic_feasibility.some((row) =>
    row.semantic === "unresolved" && present.has(row.candidate_key));
}

function prefixAllFeasible(
  world: QueryProofDecideWorldV1,
  prefix: readonly string[]
): boolean {
  const feasible = new Set(world.compiled.semantic_feasibility
    .filter((row) => row.semantic === "feasible")
    .map((row) => row.candidate_key));
  return prefix.every((key) => feasible.has(key));
}

function sealObligationsCovered(
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

function coversSealObligation(
  target: string,
  closure: ChannelClosureResult,
  compiled: QueryCompiledGammaV1,
  snapshot: string
): boolean {
  if (closure.status !== "exact_closed") return false;
  if (closure.remaining_effects.length !== 0) return false;
  if (closure.snapshot_digest !== snapshot) return false;
  if (closure.query_digest !== compiled.compilation_digest &&
      closure.query_digest !== compiled.query_digest) {
    return false;
  }
  return closure.completeness_refs.some((ref) =>
    ref.coordinate_id === target || ref.domain_id === target);
}

function mintSeal(
  digest: RecallFieldDigest,
  input: SealCheckerInputV1,
  authority: LiveQueryProofAuthority,
  outcome: FiniteDecisionOracleResult["outcomes"][number],
  walkOperatorId: DecisionStabilitySealV1["walk_operator_id"]
): DecisionStabilitySealV1 {
  const compiled = input.world.compiled;
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: DECISION_STABILITY_SEAL_OPERATOR_ID,
    decision_contract_digest: digest,
    query_digest: compiled.query_digest,
    compilation_digest: compiled.compilation_digest,
    live_compilation_digest: authority.canonical_query_compilation.digest,
    snapshot_digest: authority.snapshot_vector.vector_digest,
    gamma_digest: compiled.gamma_digest,
    walk_operator_id: walkOperatorId,
    k_max: input.k_max,
    candidate_prefix: outcome.candidate_prefix,
    answer_bindings: outcome.answer_bindings,
    pick_reasons: outcome.pick_reasons,
    outcome_digest: outcome.trace_digest
  });
  return Object.freeze({ ...body, seal_digest: digestRecallFieldIdentity(body) });
}

function open(digest: RecallFieldDigest, reason: string): SealCheckerResultV1 {
  return Object.freeze({
    status: "UNCERTIFIED_OPEN" as const,
    decision_contract_digest: digest,
    reason,
    requested_refinements: Object.freeze([])
  });
}

function unsupported(digest: RecallFieldDigest, reason: string): SealCheckerResultV1 {
  return Object.freeze({
    status: "UNSUPPORTED" as const,
    decision_contract_digest: digest,
    reason
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "seal checker failed closed";
}
