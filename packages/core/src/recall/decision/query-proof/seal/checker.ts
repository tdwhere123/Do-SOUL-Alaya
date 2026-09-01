import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { SHADOW_CAPTURE_OPERATOR_ID } from "../../prefix-capture/identity.js";
import {
  captureData,
  captureVerifiedLiveClosureAuthority
} from "../closure/live-authority-binding.js";
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
import { assertCanonicalQueryCompilationDigest } from
  "../../../query/canonical-query/compilation.js";
import { compiledGammaBodyDigest, compileQueryGamma } from "../gamma/compile.js";
import { decideWorldUniverseMismatch } from "../gamma/candidate-universe.js";
import {
  DECISION_STABILITY_SEAL_OPERATOR_ID,
  digestDecisionContract,
  LIVE_DECIDE_OPERATOR_BRAND,
  QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
  type DecisionStabilitySealV1,
  type SealCheckerResultV1
} from "./contract.js";
import {
  createQueryProofAbstractOperator,
  createQueryProofDecisionOperator,
  runQueryProofDecideQ,
  type QueryProofDecideWorldV1
} from "./decide.js";
import { digestDecideWorld, freezeDecideWorld } from "./overlay.js";

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
  let captured: SealCheckerInputV1;
  try {
    captured = captureSealCheckerPremises(input);
  } catch (error) {
    return unsupported(
      digestRecallFieldIdentity({ kind: "seal_checker_premise_capture" }),
      messageOf(error)
    );
  }
  let digest: RecallFieldDigest;
  try {
    digest = contractDigest(captured.world);
  } catch (error) {
    return unsupported(
      captured.world.compiled.compilation_digest,
      messageOf(error)
    );
  }
  if (captured.concrete_operator.operator_id !== QUERY_PROOF_FINAL_DECISION_OPERATOR_ID ||
      captured.abstract_operator.operator_id !== QUERY_PROOF_FINAL_DECISION_OPERATOR_ID) {
    return unsupported(digest, "final Decide_Q operator identity mismatch");
  }
  const identityReason = compiledIdentityMismatch(captured);
  if (identityReason !== null) return unsupported(digest, identityReason);
  const bound = bindLiveDecideOracle(captured, digest);
  if ("status" in bound) return bound;
  const { boundInput, captured: live, oracle } = bound;
  let decided;
  try {
    decided = runQueryProofDecideQ(boundInput.world, boundInput.k_max);
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
  if (hasUnresolvedSemantic(boundInput.world)) {
    return open(digest, "unresolved semantic feasibility remains");
  }
  if (!prefixAllFeasible(boundInput.world, decided.prefix)) {
    return open(digest, "selected prefix is not compiled-feasible");
  }
  if (!sealObligationsCovered(boundInput.world.compiled, boundInput.closures, live.authority)) {
    return open(digest, "seal obligations are not covered by certified closures");
  }
  if (oracle.outcomes.length !== 1) {
    return open(digest, "represented refinements do not preserve one prefix/binding/reason");
  }
  return certifyStableOutcome(boundInput, live.authority, digest, oracle, decided);
}

function captureSealCheckerPremises(input: SealCheckerInputV1): SealCheckerInputV1 {
  const world = freezeDecideWorld(input.world);
  const compiled = captureData(input.compiled);
  const fixture = captureData(input.fixture);
  const closures = captureData(input.closures);
  const coordinates = captureData(input.coordinates);
  const limits = captureData(input.limits);
  const kMax = captureData(input.k_max);
  const liveAuthority = captureVerifiedLiveClosureAuthority(input.live_authority).authority;
  return Object.freeze({
    live_authority: liveAuthority,
    fixture,
    compiled,
    world,
    concrete_operator: captureBrandedOperator(input.concrete_operator, "decide"),
    abstract_operator: captureBrandedOperator(input.abstract_operator, "evaluate"),
    closures,
    coordinates,
    limits,
    k_max: kMax
  });
}

function captureBrandedOperator<T extends object>(
  operator: T,
  callbackField: "decide" | "evaluate"
): T {
  const record = operator as Readonly<Record<string, unknown>>;
  const captured = {
    operator_id: record.operator_id,
    [callbackField]: record[callbackField]
  } as T;
  const brand = (operator as Record<symbol, unknown>)[LIVE_DECIDE_OPERATOR_BRAND];
  if (brand !== undefined) {
    Object.defineProperty(captured, LIVE_DECIDE_OPERATOR_BRAND, {
      value: brand,
      enumerable: false
    });
  }
  return Object.freeze(captured);
}

function bindLiveDecideOracle(
  input: SealCheckerInputV1,
  digest: RecallFieldDigest
): SealCheckerResultV1 | Readonly<{
  readonly boundInput: SealCheckerInputV1;
  readonly captured: ReturnType<typeof captureVerifiedLiveClosureAuthority>;
  readonly oracle: FiniteDecisionOracleResult;
}> {
  let liveConcrete;
  let liveAbstract;
  try {
    liveConcrete = createQueryProofDecisionOperator(input.world);
    liveAbstract = createQueryProofAbstractOperator(input.world);
  } catch (error) {
    return unsupported(digest, messageOf(error));
  }
  if (!isLiveBoundOperator(input.concrete_operator, input.world) ||
      !isLiveBoundOperator(input.abstract_operator, input.world)) {
    return unsupported(digest, "substitute Decide_Q operator is not the bound live implementation");
  }
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
      operator: liveConcrete
    });
  } catch (error) {
    return unsupported(digest, messageOf(error));
  }
  if (oracle.decision_operator_id !== QUERY_PROOF_FINAL_DECISION_OPERATOR_ID) {
    return unsupported(digest, "oracle operator is not the bound final decision operator");
  }
  return Object.freeze({
    boundInput: Object.freeze({
      ...input,
      concrete_operator: liveConcrete,
      abstract_operator: liveAbstract
    }),
    captured,
    oracle
  });
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
  if (authority.canonical_query_compilation.digest !== input.world.compiled.compilation_digest) {
    return unsupported(digest, "compiled compilation digest does not match live canonical query");
  }
  if (certifiedDeliveryBlocked(input)) {
    return unsupported(digest, "blocks_certified_delivery hole remains");
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
  if (compiledGammaBodyDigest(compiled) !== compiled.gamma_digest ||
      compiledGammaBodyDigest(world) !== world.gamma_digest) {
    return "compiled Gamma digest does not match Gamma body";
  }
  if (!sameWalkedGamma(compiled, world)) {
    return "compiled Gamma does not match Decide_Q world";
  }
  if (input.world.compile_input.compilation.digest !== world.compilation_digest) {
    return "Decide_Q world compilation digest does not match compiled contract";
  }
  const universe = decideWorldUniverseMismatch(
    input.world.compile_input.candidates.map((candidate) => candidate.candidate_key),
    input.world.candidates.map((candidate) => candidate.candidate_key),
    world
  );
  if (universe !== null) return universe;
  try {
    assertCanonicalQueryCompilationDigest(input.world.compile_input.compilation);
  } catch (error) {
    return messageOf(error);
  }
  let recomputed: QueryCompiledGammaV1;
  try {
    recomputed = compileQueryGamma(input.world.compile_input);
  } catch (error) {
    return messageOf(error);
  }
  if (!sameWalkedGamma(recomputed, world)) {
    return "compiled Gamma does not match Decide_Q compile input";
  }
  return null;
}

function sameWalkedGamma(
  left: QueryCompiledGammaV1,
  right: QueryCompiledGammaV1
): boolean {
  return left.compile_status === right.compile_status &&
    left.gamma_digest === right.gamma_digest &&
    digestRecallFieldIdentity(left.standings) ===
      digestRecallFieldIdentity(right.standings) &&
    digestRecallFieldIdentity(left.semantic_feasibility) ===
      digestRecallFieldIdentity(right.semantic_feasibility);
}

function isLiveBoundOperator(
  operator: object,
  world: QueryProofDecideWorldV1
): boolean {
  const branded = (operator as Record<symbol, unknown>)[LIVE_DECIDE_OPERATOR_BRAND];
  return branded === digestDecideWorld(world);
}

function certifiedDeliveryBlocked(input: SealCheckerInputV1): boolean {
  return hasCertifiedDeliveryHole(input.live_authority.canonical_query_compilation.holes) ||
    hasCertifiedDeliveryHole(input.world.compile_input.compilation.holes);
}

function hasCertifiedDeliveryHole(
  holes: readonly { readonly impacts: readonly string[] }[]
): boolean {
  return holes.some((hole) => hole.impacts.includes("blocks_certified_delivery"));
}

export function digestQueryProofState(input: SealCheckerInputV1): RecallFieldDigest {
  return digestRecallFieldIdentity({
    kind: "query_proof_proof_state_v1",
    fixture: input.fixture,
    k_max: input.k_max,
    coordinates: input.coordinates,
    limits: input.limits,
    closures: input.closures.map((closure) => closure.result_digest)
  });
}

function contractDigest(world: QueryProofDecideWorldV1): RecallFieldDigest {
  const transfer = createQueryCompiledWalkTransfer(world.compiled);
  return digestDecisionContract(world.compiled, transfer.contract_digest);
}

function hasUnresolvedSemantic(world: QueryProofDecideWorldV1): boolean {
  const semantic = uniqueSemanticByCandidate(world);
  if (semantic === null) return true;
  return world.candidates.some((row) => semantic.get(row.candidate_key) === "unresolved");
}

function prefixAllFeasible(
  world: QueryProofDecideWorldV1,
  prefix: readonly string[]
): boolean {
  const semantic = uniqueSemanticByCandidate(world);
  if (semantic === null) return false;
  return prefix.every((key) => semantic.get(key) === "feasible");
}

function uniqueSemanticByCandidate(
  world: QueryProofDecideWorldV1
): Map<string, QueryCompiledGammaV1["semantic_feasibility"][number]["semantic"]> | null {
  const semantic = new Map<string, QueryCompiledGammaV1["semantic_feasibility"][number]["semantic"]>();
  for (const row of world.compiled.semantic_feasibility) {
    if (semantic.has(row.candidate_key)) return null;
    semantic.set(row.candidate_key, row.semantic);
  }
  return semantic;
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
  const liveCompilationDigest = authority.canonical_query_compilation.digest;
  if (liveCompilationDigest !== compiled.compilation_digest) {
    throw new Error("seal live canonical query is not the compiled contract");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: DECISION_STABILITY_SEAL_OPERATOR_ID,
    decision_contract_digest: digest,
    query_digest: compiled.query_digest,
    compilation_digest: compiled.compilation_digest,
    live_compilation_digest: liveCompilationDigest,
    world_digest: digestDecideWorld(input.world),
    proof_state_digest: digestQueryProofState(input),
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
