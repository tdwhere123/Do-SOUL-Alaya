import { digestRecallFieldIdentity } from "../../../field/field-identity.js";
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
import { certifiedSemanticSet } from "../gamma/evaluate.js";
import { createQueryCompiledWalkTransfer } from "../gamma/walk-binding.js";
import type { QueryCompiledGammaV1 } from "../gamma/contract.js";
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
  QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
  sortDecisionBindings
} from "./contract.js";
import { freezeDecideWorld, overlayWorld } from "./overlay.js";

export type QueryProofDecideWorldV1 = Readonly<{
  readonly compiled: QueryCompiledGammaV1;
  readonly compile_input: QueryGammaCompileInputV1;
  readonly candidates: readonly ShadowCaptureWalkCandidate[];
  readonly psi_edges: readonly (readonly [string, string])[];
  readonly token_budget: number;
  readonly per_dimension_limits: Readonly<Record<string, number>> | null;
  readonly unresolved_tradeoff_pairs: readonly (readonly [string, string])[];
  readonly answer_bindings: readonly Readonly<{
    readonly candidate_key: string;
    readonly binding_id: string;
    readonly value: FiniteValue;
  }>[];
}>;

export type QueryProofDecideResultV1 = Readonly<{
  readonly decision_contract_digest: ReturnType<typeof digestDecisionContract>;
  readonly walk: ShadowCapturedWalk;
  readonly prefix: readonly string[];
  readonly trace: FiniteDecisionTraceInput;
  readonly unresolved_boundary_tradeoff: boolean;
}>;

export function emptyWalkUtility(candidateKey: string, objectKey: string) {
  return emptySetUtilityInput(candidateKey, objectKey);
}

export function runQueryProofDecideQ(
  world: QueryProofDecideWorldV1,
  kMax: number
): QueryProofDecideResultV1 {
  const transfer = createQueryCompiledWalkTransfer(world.compiled);
  const certified = certifiedSemanticSet(world.compiled);
  const candidates = world.candidates.map((candidate) => Object.freeze({
    ...candidate,
    h_eligible: candidate.h_eligible && certified.has(candidate.candidate_key)
  }));
  const budgets = boundResourcePolicy(world);
  const walked = walkShadowCapture({
    candidates,
    psi: psiFrom(world.psi_edges),
    token_budget: budgets.token_budget,
    per_dimension_limits: budgets.per_dimension_limits,
    unresolved_tradeoff: tradeoffFrom(world.unresolved_tradeoff_pairs),
    utility_transfer: transfer
  });
  if (!isCapturedWalk(walked)) {
    throw new Error("query-proof Decide_Q hit a Psi cycle");
  }
  const prefix = prefixSK(walked.S_infty, kMax);
  const trace = traceOf(walked, prefix, world.answer_bindings);
  return Object.freeze({
    decision_contract_digest: digestDecisionContract(world.compiled, transfer.contract_digest),
    walk: walked,
    prefix,
    trace,
    unresolved_boundary_tradeoff: walked.decisions
      .some((decision) => decision.unresolved_pointwise_tradeoff)
  });
}

export function createQueryProofDecisionOperator(
  world: QueryProofDecideWorldV1
): FiniteDecisionOperator {
  const frozen = freezeDecideWorld(world);
  const transfer = createQueryCompiledWalkTransfer(frozen.compiled);
  const digest = digestDecisionContract(frozen.compiled, transfer.contract_digest);
  return Object.freeze({
    operator_id: QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
    decide: ({ base_state, refinement, k_max }) => {
      const overlay = overlayWorld(frozen, base_state, refinement);
      const decided = runQueryProofDecideQ(overlay, k_max);
      if (decided.decision_contract_digest !== digest) {
        throw new Error("Decide_Q decision-contract digest drifted");
      }
      return decided.trace;
    }
  });
}

export function createQueryProofAbstractOperator(
  world: QueryProofDecideWorldV1
): AbstractDecisionOperator {
  const frozen = freezeDecideWorld(world);
  const concrete = createQueryProofDecisionOperator(frozen);
  return Object.freeze({
    operator_id: QUERY_PROOF_FINAL_DECISION_OPERATOR_ID,
    evaluate: (input) => evaluateAbstractDecide(frozen, concrete, input)
  });
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
    return `identity:${candidateKey}`;
  }
  const atoms = decision.named_novelty.compiled_atom_ids ?? [];
  if (atoms.length > 0) return `${decision.capture_reason}:${atoms.join(",")}`;
  return `${decision.capture_reason}:${candidateKey}`;
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
  return Object.freeze({
    gamma_digest: world.compiled.gamma_digest,
    candidate_keys: Object.freeze(world.candidates.map((row) => row.candidate_key)),
    token_budget: world.token_budget
  });
}

