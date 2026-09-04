import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import {
  isCapturedWalk,
  prefixSK,
  walkShadowCapture,
  type ShadowCaptureWalkCandidate,
  type ShadowCapturedWalk
} from "../../prefix-capture/walk.js";
import { emptySetUtilityInput } from "../../prefix-capture/capture.js";
import type { PsiQuery } from "../../dominance-contract.js";
import type { QueryGammaCompileInputV1 } from "../gamma/compile.js";
import { decideWorldUniverseMismatch } from "../gamma/candidate-universe.js";
import {
  provedInfeasibleCandidateKeys,
  semanticFeasibilityMap
} from "../gamma/evaluate.js";
import { createQueryCompiledWalkTransfer } from "../gamma/walk-binding.js";
import {
  captureGammaPremises,
  holeBlocksCertifiedDelivery,
  isExecutableCompiledGamma,
  type QueryCompiledGammaV1
} from "../gamma/contract.js";
import type {
  AbstractCoordinate,
  AbstractDecisionOperator,
  AbstractOperatorEvaluation
} from "../proof/abstract/contract.js";
import type {
  FiniteConcreteRefinement,
  FiniteDecisionOperator,
  FiniteDecisionTraceInput,
  FiniteValue
} from "../proof/oracle/contract.js";
import {
  digestDecisionContract,
  LIVE_DECIDE_OPERATOR_BRAND,
  QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
  sortDecisionBindings
} from "./contract.js";
import {
  candidateIdentityMapForWorld,
  decideWorldCapture,
  digestDecideWorld,
  freezeDecideWorld,
  queryProofDecideBaseState,
  type QueryProofDecideWorldCaptureV1
} from "./world-capture.js";
import { overlayWorld } from "./overlay.js";

export type QueryProofDecideWorldV1 = Readonly<{
  readonly compiled: QueryCompiledGammaV1;
  readonly compile_input: QueryGammaCompileInputV1;
  readonly candidates: readonly ShadowCaptureWalkCandidate[];
  readonly psi_edges: readonly (readonly [string, string])[];
  readonly token_budget: number;
  readonly per_dimension_limits: Readonly<Record<string, number>> | null;
  readonly unresolved_tradeoff_pairs: readonly (readonly [string, string])[];
  readonly identity_tie_winner?: string;
  readonly source_evidence_digest?: RecallFieldDigest | null;
  readonly psi_identity?: RecallFieldDigest | null;
  readonly answer_bindings: readonly Readonly<{
    readonly candidate_key: string;
    readonly binding_id: string;
    readonly variable: string;
    readonly semantic_identity: string;
    readonly value: FiniteValue;
  }>[];
}>;

export type QueryProofExecutionDispositionV1 =
  | "captured"
  | "best_effort"
  | "abstained"
  | "unsupported"
  | "conflict"
  | "failed";

export type QueryProofPackModeV1 =
  | "certified"
  | "best_effort_uncertified"
  | "abstained"
  | "unsupported"
  | "conflict";

export type QueryProofDecideResultV1 = Readonly<{
  readonly decision_contract_digest: ReturnType<typeof digestDecisionContract>;
  readonly decision_identity_digest: RecallFieldDigest;
  readonly walk: ShadowCapturedWalk;
  readonly prefix: readonly string[];
  readonly trace: FiniteDecisionTraceInput;
  readonly unresolved_boundary_tradeoff: boolean;
  readonly disposition: QueryProofExecutionDispositionV1;
  readonly pack_mode: QueryProofPackModeV1;
}>;

export function emptyWalkUtility(candidateKey: string, objectKey: string) {
  return emptySetUtilityInput(candidateKey, objectKey);
}

export function runQueryProofDecideQ(
  world: QueryProofDecideWorldV1,
  kMax: number
): QueryProofDecideResultV1 {
  if (!Number.isSafeInteger(kMax) || kMax <= 0) {
    throw new Error("Decide_Q K_max must be a positive safe integer");
  }
  const issued = decideWorldCapture(world);
  const captured = freezeDecideWorld(captureGammaPremises(world));
  if (issued !== null && digestDecideWorld(captured) !== issued.world_digest) {
    throw new Error("Decide_Q captured premises do not match issued world identity");
  }
  const universe = decideWorldUniverseMismatch(
    captured.compile_input.candidates.map((candidate) => candidate.candidate_key),
    captured.candidates.map((candidate) => candidate.candidate_key),
    captured.compiled
  );
  if (universe !== null) {
    throw new Error(universe);
  }
  const executable = isExecutableCompiledGamma(captured.compiled);
  const infeasible = executable
    ? provedInfeasibleCandidateKeys(captured.compiled)
    : new Set<string>();
  const candidates = executable
    ? captured.candidates.map((candidate) => Object.freeze({
      ...candidate,
      // Unresolved stays in remaining; dropping it here would recertify by omission.
      h_eligible: candidate.h_eligible && !infeasible.has(candidate.candidate_key)
    }))
    : Object.freeze([] as typeof captured.candidates);
  const identityTieWinner = !executable || captured.unresolved_tradeoff_pairs.length > 0
    ? undefined
    : captured.identity_tie_winner;
  const transfer = createQueryCompiledWalkTransfer(captured.compiled, identityTieWinner);
  const budgets = boundResourcePolicy(captured);
  const walked = walkShadowCapture({
    candidates,
    psi: psiFrom(captured.psi_edges),
    token_budget: budgets.token_budget,
    per_dimension_limits: budgets.per_dimension_limits,
    unresolved_tradeoff: tradeoffFrom(captured.unresolved_tradeoff_pairs),
    utility_transfer: transfer
  });
  if (!isCapturedWalk(walked)) {
    throw new Error("query-proof Decide_Q hit a Psi cycle");
  }
  const prefix = prefixSK(walked.S_infty, kMax);
  const trace = traceOf(walked, prefix, captured.answer_bindings);
  const feasibility = semanticFeasibilityMap(captured.compiled);
  const hasConflict = walked.decisions.some((decision) => decision.unresolved_pointwise_tradeoff);
  const hasUnresolvedInPrefix = prefix.some((key) => feasibility.get(key) === "unresolved");
  const modes = decideModes({
    compiled: captured.compiled,
    prefix,
    hasConflict,
    hasUnresolvedInPrefix
  });
  const decisionContractDigest = digestDecisionContract(
    captured.compiled, transfer.contract_digest);
  return Object.freeze({
    decision_contract_digest: decisionContractDigest,
    decision_identity_digest: digestDecideConsumedIdentity({
      world: captured,
      issued,
      prefix,
      walk_transfer_digest: transfer.contract_digest,
      decision_contract_digest: decisionContractDigest
    }),
    walk: walked,
    prefix,
    trace,
    unresolved_boundary_tradeoff: hasConflict,
    disposition: modes.disposition,
    pack_mode: modes.pack_mode
  });
}

export function createQueryProofDecisionOperator(
  world: QueryProofDecideWorldV1
): FiniteDecisionOperator {
  const frozen = freezeDecideWorld(world);
  const operator: FiniteDecisionOperator = {
    operator_id: QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
    decide: ({ base_state, refinement, k_max }) => {
      const overlay = overlayWorld(frozen, base_state, refinement);
      const decided = runQueryProofDecideQ(overlay, k_max);
      return decided.trace;
    }
  };
  return Object.freeze(brandLiveOperator(operator, digestDecideWorld(frozen)));
}

export function createQueryProofAbstractOperator(
  world: QueryProofDecideWorldV1
): AbstractDecisionOperator {
  const frozen = freezeDecideWorld(world);
  const concrete = createQueryProofDecisionOperator(frozen);
  const operator: AbstractDecisionOperator = {
    operator_id: QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
    evaluate: (input) => evaluateAbstractDecide(frozen, concrete, input)
  };
  return Object.freeze(brandLiveOperator(operator, digestDecideWorld(frozen)));
}

function brandLiveOperator<T extends object>(operator: T, worldDigest: ReturnType<typeof digestDecideWorld>): T {
  Object.defineProperty(operator, LIVE_DECIDE_OPERATOR_BRAND, {
    value: worldDigest,
    enumerable: false
  });
  return operator;
}

function evaluateAbstractDecide(
  world: QueryProofDecideWorldV1,
  concrete: FiniteDecisionOperator,
  input: Readonly<{
    readonly coordinates: readonly AbstractCoordinate[];
    readonly remaining_effects: readonly unknown[];
    readonly k_max: number;
    readonly transfer_digest: string;
  }>
): AbstractOperatorEvaluation {
  if (input.coordinates.some((coordinate) =>
    coordinate.kind === "identity_tie" && coordinate.universe === "open")) {
    return Object.freeze({
      status: "unsupported" as const,
      reason: "open identity tail remains uncertified"
    });
  }
  if (input.coordinates.some(isUnrepresentableCoordinate)) {
    return Object.freeze({
      status: "unsupported" as const,
      reason: "abstract Decide_Q contains an unresolved or unrepresentable domain"
    });
  }
  const assignments = abstractAssignments(input.coordinates);
  if (assignments === null) {
    return Object.freeze({
      status: "unsupported" as const,
      reason: "abstract Decide_Q domain is not finite"
    });
  }
  const traces = assignments.map((refinement) =>
    concrete.decide({
      base_state: worldAsFinite(world),
      refinement,
      k_max: input.k_max
    }));
  return Object.freeze({
    status: "outcomes" as const,
    handled_sensitivity_ids: Object.freeze(
      input.coordinates.map((coordinate) => coordinate.sensitivity_id)
    ),
    outcomes: Object.freeze(traces)
  });
}

function decideModes(params: Readonly<{
  readonly compiled: QueryCompiledGammaV1;
  readonly prefix: readonly string[];
  readonly hasConflict: boolean;
  readonly hasUnresolvedInPrefix: boolean;
}>): Readonly<{
  readonly disposition: QueryProofExecutionDispositionV1;
  readonly pack_mode: QueryProofPackModeV1;
}> {
  if (!isExecutableCompiledGamma(params.compiled)) {
    return { disposition: "unsupported", pack_mode: "unsupported" };
  }
  if (params.hasConflict) {
    return { disposition: "conflict", pack_mode: "conflict" };
  }
  const certBlocked = params.compiled.compile_disposition === "partial" ||
    holeBlocksCertifiedDelivery(params.compiled.classified_holes);
  if (params.hasUnresolvedInPrefix || certBlocked) {
    return { disposition: "best_effort", pack_mode: "best_effort_uncertified" };
  }
  if (params.prefix.length === 0) {
    return { disposition: "abstained", pack_mode: "abstained" };
  }
  return { disposition: "captured", pack_mode: "certified" };
}

export function digestDecideConsumedIdentity(params: Readonly<{
  readonly world: QueryProofDecideWorldV1;
  readonly prefix: readonly string[];
  readonly walk_transfer_digest: RecallFieldDigest;
  readonly decision_contract_digest: RecallFieldDigest;
  readonly issued?: QueryProofDecideWorldCaptureV1 | null;
}>): RecallFieldDigest {
  const world = params.world;
  const issued = params.issued ?? decideWorldCapture(world);
  const sourceEvidence = issued?.source_evidence_digest ??
    world.source_evidence_digest ??
    world.compiled.source_evidence_digest;
  const psiIdentity = issued?.psi_v2_structural_digest ?? world.psi_identity;
  return digestRecallFieldIdentity({
    kind: "query_proof_decide_q_consumed_identity_v1",
    decision_contract_digest: params.decision_contract_digest,
    walk_transfer_digest: params.walk_transfer_digest,
    compilation_digest: world.compiled.compilation_digest,
    query_digest: world.compiled.query_digest,
    compile_disposition: world.compiled.compile_disposition,
    classified_holes: world.compiled.classified_holes,
    gamma_digest: world.compiled.gamma_digest,
    atoms: world.compiled.atoms,
    standings: world.compiled.standings,
    semantic_feasibility: world.compiled.semantic_feasibility,
    candidate_universe_digest: issued?.candidate_universe_digest ??
      digestRecallFieldIdentity(candidateIdentityMapForWorld(world)),
    resource_policy: world.compiled.resource_policy,
    ...(sourceEvidence === undefined || sourceEvidence === null ? {} : {
      source_evidence_digest: sourceEvidence
    }),
    ...(psiIdentity === undefined || psiIdentity === null ? {} : {
      psi_identity: psiIdentity
    }),
    unresolved_tradeoff_pairs: world.unresolved_tradeoff_pairs,
    ...(world.identity_tie_winner === undefined ? {} : {
      identity_tie_winner: world.identity_tie_winner
    }),
    target_prefix: params.prefix
  });
}

function boundResourcePolicy(world: QueryProofDecideWorldV1): {
  readonly token_budget: number;
  readonly per_dimension_limits: Readonly<Record<string, number>> | null;
} {
  const policy = world.compiled.resource_policy;
  if (policy.token_budget !== null && policy.token_budget !== world.token_budget) {
    throw new Error("compiled resource policy does not match Decide_Q world budget");
  }
  if (policy.per_dimension_limits !== null &&
    !sameDimensionLimits(policy.per_dimension_limits, world.per_dimension_limits)) {
    throw new Error("compiled resource policy does not match Decide_Q dimension limits");
  }
  return {
    token_budget: policy.token_budget ?? world.token_budget,
    per_dimension_limits: policy.per_dimension_limits ?? world.per_dimension_limits
  };
}

function sameDimensionLimits(
  policy: Readonly<Record<string, number>>,
  world: Readonly<Record<string, number>> | null
): boolean {
  if (world === null) return false;
  const keys = new Set([...Object.keys(policy), ...Object.keys(world)]);
  return [...keys].every((key) => policy[key] === world[key]);
}

function abstractAssignments(
  coordinates: readonly AbstractCoordinate[]
): readonly FiniteConcreteRefinement[] | null {
  let rows: readonly FiniteConcreteRefinement["assignments"][] = [Object.freeze([])];
  for (const coordinate of coordinates) {
    const choices = choicesOf(coordinate);
    if (choices === null) return null;
    rows = rows.flatMap((prefix) => choices.map((choice) =>
      Object.freeze([...prefix, Object.freeze({
        coordinate_id: coordinate.coordinate_id,
        owner_id: coordinate.owner_id,
        kind: concreteKind(coordinate),
        choice_id: choice.choice_id,
        value: choice.value
      })])));
  }
  return Object.freeze(rows.map((assignments) => Object.freeze({
    assignments,
    refinement_digest: digestRecallFieldIdentity(assignments)
  })));
}

function isUnrepresentableCoordinate(coordinate: AbstractCoordinate): boolean {
  if (coordinate.kind === "semantic_feasibility") {
    return coordinate.possible_states.includes("unresolved");
  }
  if (coordinate.kind === "correlation") {
    return coordinate.possible_relations.includes("unknown");
  }
  if (coordinate.kind === "four_valued_proposition") {
    return coordinate.possible_values.includes("both") ||
      coordinate.possible_values.includes("unknown");
  }
  return false;
}

function choicesOf(
  coordinate: AbstractCoordinate
): readonly Readonly<{ readonly choice_id: string; readonly value: FiniteValue }>[] | null {
  if (coordinate.kind === "membership") {
    return coordinate.possible_states.map((state) => Object.freeze({
      choice_id: state,
      value: state === "present"
    }));
  }
  if (coordinate.kind === "semantic_feasibility") {
    return coordinate.possible_states.map((state) => Object.freeze({
      choice_id: state,
      value: state
    }));
  }
  if (coordinate.kind === "binding") {
    return coordinate.possible_bindings.map((value) => Object.freeze({
      choice_id: value,
      value
    }));
  }
  if (coordinate.kind === "identity_tie") {
    return coordinate.possible_winner_digests.map((value) => Object.freeze({
      choice_id: value,
      value
    }));
  }
  if (coordinate.kind === "correlation") {
    return coordinate.possible_relations.map((value) => Object.freeze({
      choice_id: value,
      value
    }));
  }
  if (coordinate.kind === "four_valued_proposition") {
    return coordinate.possible_values.map((value) => Object.freeze({
      choice_id: value,
      value
    }));
  }
  return null;
}

function concreteKind(
  coordinate: AbstractCoordinate
): FiniteConcreteRefinement["assignments"][number]["kind"] {
  if (coordinate.kind === "membership") return "candidate_membership";
  if (coordinate.kind === "semantic_feasibility") return "semantic_feasibility";
  if (coordinate.kind === "binding") return "answer_binding";
  if (coordinate.kind === "identity_tie") return "identity_tie";
  if (coordinate.kind === "correlation") return "correlation_state";
  return "proposition_conflict";
}

function traceOf(
  walked: ShadowCapturedWalk,
  prefix: readonly string[],
  bindings: QueryProofDecideWorldV1["answer_bindings"]
): FiniteDecisionTraceInput {
  const selected = new Set(prefix);
  return Object.freeze({
    candidate_prefix: Object.freeze([...prefix]),
    answer_bindings: sortDecisionBindings(bindings.filter((row) =>
      selected.has(row.candidate_key)).map((row) => Object.freeze({
        binding_id: row.binding_id,
        value: row.value
      }))),
    pick_reasons: Object.freeze(prefix.map((candidateKey, position) => Object.freeze({
      position,
      candidate_key: candidateKey,
      reason_id: reasonId(walked, candidateKey, position)
    })))
  });
}

function reasonId(
  walked: ShadowCapturedWalk,
  candidateKey: string,
  position: number
): string {
  const decision = walked.decisions[position];
  if (decision === undefined || decision.candidate_key !== candidateKey) {
    return `decision:${digestRecallFieldIdentity({ candidate_key: candidateKey, position })}`;
  }
  return `decision:${digestRecallFieldIdentity({
    candidate_key: candidateKey,
    position,
    capture_reason: decision.capture_reason,
    G: decision.G,
    compiled_atom_ids: decision.named_novelty.compiled_atom_ids ?? [],
    max_g_cohort: decision.max_g_cohort,
    equal_g_dominance_rejects: decision.equal_g_dominance_rejects,
    deterministic_tail: decision.deterministic_tail,
    static_frontier_index: decision.static_frontier_index
  })}`;
}

function psiFrom(edges: QueryProofDecideWorldV1["psi_edges"]): PsiQuery {
  const set = new Set(edges.map(([dominator, dominated]) => `${dominator}\0${dominated}`));
  return (dominator, dominated) => set.has(`${dominator}\0${dominated}`);
}

function tradeoffFrom(
  pairs: QueryProofDecideWorldV1["unresolved_tradeoff_pairs"]
): ((left: string, right: string) => boolean) | undefined {
  if (pairs.length === 0) return undefined;
  const set = new Set(pairs.flatMap(([left, right]) => [
    `${left}\0${right}`,
    `${right}\0${left}`
  ]));
  return (left, right) => set.has(`${left}\0${right}`);
}

function worldAsFinite(world: QueryProofDecideWorldV1): FiniteValue {
  if (decideWorldCapture(world) !== null) return queryProofDecideBaseState(world);
  return Object.freeze({
    gamma_digest: world.compiled.gamma_digest,
    candidate_keys: Object.freeze(world.candidates.map((row) => row.candidate_key)),
    token_budget: world.token_budget
  });
}
