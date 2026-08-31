import { compileQueryGamma } from "../gamma/compile.js";
import type { QueryGammaCandidateEvidenceV1 } from "../gamma/contract.js";
import type {
  FiniteConcreteRefinement,
  FiniteValue
} from "../proof/oracle/contract.js";
import type { ShadowCaptureWalkCandidate } from "../../prefix-capture/walk.js";
import type { QueryProofDecideWorldV1 } from "./decide.js";

export function overlayWorld(
  world: QueryProofDecideWorldV1,
  baseState: FiniteValue,
  refinement: FiniteConcreteRefinement
): QueryProofDecideWorldV1 {
  assertOverlayBaseState(world, baseState);
  const baseline = freezeDecideWorld(world);
  let candidates: ShadowCaptureWalkCandidate[] = [...baseline.candidates];
  let evidence: QueryGammaCandidateEvidenceV1[] = [...baseline.compile_input.candidates];
  const bindings = [...baseline.answer_bindings];
  let recompile = false;
  for (const assignment of refinement.assignments) {
    if (assignment.kind === "correlation_state" ||
        assignment.kind === "proposition_conflict") {
      recompile = true;
    }
    const applied = applyAssignment(assignment, candidates, evidence, bindings);
    candidates = [...applied.candidates];
    evidence = [...applied.evidence];
  }
  const compileInput = Object.freeze({
    ...baseline.compile_input,
    candidates: Object.freeze(evidence)
  });
  const compiled = recompile ? compileQueryGamma(compileInput) : baseline.compiled;
  if (compiled.compile_status !== "compiled") {
    throw new Error("Decide_Q overlay left Gamma unsupported");
  }
  return freezeDecideWorld({
    ...baseline,
    compiled,
    compile_input: compileInput,
    candidates: Object.freeze(candidates),
    answer_bindings: Object.freeze(bindings)
  });
}

export function freezeDecideWorld(world: QueryProofDecideWorldV1): QueryProofDecideWorldV1 {
  return Object.freeze({
    compiled: world.compiled,
    compile_input: Object.freeze({
      ...world.compile_input,
      candidates: Object.freeze([...world.compile_input.candidates])
    }),
    candidates: Object.freeze(world.candidates.map((row) => Object.freeze({ ...row }))),
    psi_edges: Object.freeze(world.psi_edges.map((edge) =>
      Object.freeze([edge[0], edge[1]] as [string, string]))),
    token_budget: world.token_budget,
    per_dimension_limits: world.per_dimension_limits === null
      ? null
      : Object.freeze({ ...world.per_dimension_limits }),
    unresolved_tradeoff_pairs: Object.freeze(
      world.unresolved_tradeoff_pairs.map((pair) =>
        Object.freeze([pair[0], pair[1]] as [string, string]))
    ),
    answer_bindings: Object.freeze([...world.answer_bindings])
  });
}

function assertOverlayBaseState(
  world: QueryProofDecideWorldV1,
  baseState: FiniteValue
): void {
  if (typeof baseState !== "object" || baseState === null || Array.isArray(baseState)) {
    return;
  }
  const record = baseState as Readonly<Record<string, FiniteValue>>;
  if ("gamma_digest" in record && record.gamma_digest !== world.compiled.gamma_digest) {
    throw new Error("Decide_Q overlay base_state identity mismatch");
  }
}

function applyAssignment(
  assignment: FiniteConcreteRefinement["assignments"][number],
  candidates: readonly ShadowCaptureWalkCandidate[],
  evidence: readonly QueryGammaCandidateEvidenceV1[],
  bindings: Array<QueryProofDecideWorldV1["answer_bindings"][number]>
): {
  readonly candidates: readonly ShadowCaptureWalkCandidate[];
  readonly evidence: readonly QueryGammaCandidateEvidenceV1[];
} {
  if (assignment.kind === "candidate_membership") {
    if (assignment.value !== false) return { candidates, evidence };
    return {
      candidates: candidates.filter((row) => row.candidate_key !== assignment.coordinate_id),
      evidence: evidence.filter((row) => row.candidate_key !== assignment.coordinate_id)
    };
  }
  if (assignment.kind === "semantic_feasibility") {
    if (assignment.value === "feasible") return { candidates, evidence };
    return {
      candidates: candidates.map((row) => row.candidate_key === assignment.coordinate_id
        ? Object.freeze({ ...row, h_eligible: false })
        : row),
      evidence
    };
  }
  if (assignment.kind === "answer_binding") {
    const owner = bindingOwner(assignment.coordinate_id, candidates);
    const next = Object.freeze({
      candidate_key: owner,
      binding_id: assignment.coordinate_id,
      value: assignment.value
    });
    const index = bindings.findIndex((row) =>
      row.candidate_key === owner && row.binding_id === assignment.coordinate_id);
    if (index >= 0) bindings[index] = next;
    else bindings.push(next);
    return { candidates, evidence };
  }
  if (assignment.kind === "identity_tie") {
    const winner = String(assignment.value);
    return {
      candidates: candidates.filter((row) => row.candidate_key === winner),
      evidence: evidence.filter((row) => row.candidate_key === winner)
    };
  }
  if (assignment.kind === "correlation_state") {
    return {
      candidates,
      evidence: overlayIndependence(evidence, assignment.coordinate_id, assignment.value)
    };
  }
  if (assignment.kind === "proposition_conflict") {
    return {
      candidates,
      evidence: overlayProposition(evidence, assignment.coordinate_id, assignment.value)
    };
  }
  throw new Error(`Decide_Q cannot apply remaining effect ${assignment.kind}`);
}

function bindingOwner(
  coordinateId: string,
  candidates: readonly ShadowCaptureWalkCandidate[]
): string {
  if (candidates.some((row) => row.candidate_key === coordinateId)) return coordinateId;
  if (candidates.length === 1) return candidates[0]!.candidate_key;
  throw new Error("Decide_Q cannot apply unbound answer_binding");
}

function overlayIndependence(
  evidence: readonly QueryGammaCandidateEvidenceV1[],
  coordinateId: string,
  value: FiniteValue
): readonly QueryGammaCandidateEvidenceV1[] {
  const independence = value === "unknown"
    ? "unknown" as const
    : value === "different_group"
      ? "certified_independent" as const
      : "correlated" as const;
  return evidence.map((row) => {
    if (coordinateId !== "correlation" && row.candidate_key !== coordinateId) return row;
    return Object.freeze({
      ...row,
      propositions: Object.freeze(row.propositions.map((proposition) => Object.freeze({
        ...proposition,
        independence
      })))
    });
  });
}

function overlayProposition(
  evidence: readonly QueryGammaCandidateEvidenceV1[],
  propositionId: string,
  value: FiniteValue
): readonly QueryGammaCandidateEvidenceV1[] {
  const support = value === "supported_only"
    ? "supports" as const
    : value === "unknown"
      ? "unknown" as const
      : "refutes" as const;
  return evidence.map((row) => Object.freeze({
    ...row,
    propositions: Object.freeze(row.propositions.map((proposition) =>
      proposition.proposition_id === propositionId
        ? Object.freeze({ ...proposition, support })
        : proposition))
  }));
}
