import { captureData } from "../closure/live-authority-binding.js";
import { compileQueryGamma } from "../gamma/compile.js";
import { projectCompiledToCandidateKeys } from "../gamma/candidate-universe.js";
import type { QueryGammaCandidateEvidenceV1 } from "../gamma/contract.js";
import type {
  FiniteConcreteRefinement,
  FiniteValue
} from "../proof/oracle/contract.js";
import type { ShadowCaptureWalkCandidate } from "../../prefix-capture/walk.js";
import type { QueryProofDecideWorldV1 } from "./decide.js";
import {
  candidateIdentityMapForWorld,
  decideWorldCapture,
  freezeDecideWorld,
  issueDerivedQueryProofDecideWorld,
  queryProofDecideBaseState
} from "./world-capture.js";

export function overlayWorld(
  world: QueryProofDecideWorldV1,
  baseState: FiniteValue,
  refinement: FiniteConcreteRefinement
): QueryProofDecideWorldV1 {
  assertOverlayBaseState(world, baseState);
  const baseline = freezeDecideWorld(world);
  const capture = decideWorldCapture(baseline);
  let candidates: ShadowCaptureWalkCandidate[] = [...baseline.candidates];
  let evidence: QueryGammaCandidateEvidenceV1[] = [...baseline.compile_input.candidates];
  const bindings = [...baseline.answer_bindings];
  let recompile = false;
  const semanticOverrides = new Map<string, "feasible" | "infeasible">();
  for (const assignment of refinement.assignments) {
    if (assignment.kind === "answer_binding" ||
        assignment.kind === "correlation_state" ||
        assignment.kind === "proposition_conflict") {
      recompile = true;
    }
    if (assignment.kind === "semantic_feasibility") {
      if (assignment.value === "unresolved") {
        throw new Error("Decide_Q cannot concretize unresolved semantic feasibility");
      }
      if (assignment.value !== "feasible" && assignment.value !== "infeasible") {
        throw new Error("Decide_Q semantic feasibility refinement is invalid");
      }
      semanticOverrides.set(assignment.owner_id, assignment.value);
      continue;
    }
    const applied = applyAssignment(
      assignment,
      candidates,
      evidence,
      bindings,
      capture?.candidate_identity_by_digest ?? candidateIdentityMapForWorld(baseline)
    );
    candidates = [...applied.candidates];
    evidence = [...applied.evidence];
  }
  const compileInput = Object.freeze({
    ...baseline.compile_input,
    candidates: Object.freeze(evidence)
  });
  const compiled = recompile || semanticOverrides.size > 0
    ? compileQueryGamma(compileInput)
    : baseline.compiled;
  if (compiled.compile_status !== "compiled") {
    throw new Error("Decide_Q overlay left Gamma unsupported");
  }
  const projected = projectCompiledToCandidateKeys(
    compiled,
    compileInput.candidates.map((candidate) => candidate.candidate_key)
  );
  const overlaid = captureData({
    ...baseline,
    compiled: applySemanticOverrides(projected, semanticOverrides),
    compile_input: compileInput,
    candidates: Object.freeze(candidates),
    answer_bindings: Object.freeze(bindings)
  }) as QueryProofDecideWorldV1;
  if (capture === null) return overlaid;
  return issueDerivedQueryProofDecideWorld(overlaid, baseline, capture);
}

function assertOverlayBaseState(
  world: QueryProofDecideWorldV1,
  baseState: FiniteValue
): void {
  const capture = decideWorldCapture(world);
  if (capture === null) {
    if (typeof baseState !== "object" || baseState === null || Array.isArray(baseState)) return;
    const record = baseState as Readonly<Record<string, FiniteValue>>;
    if ("gamma_digest" in record && record.gamma_digest !== world.compiled.gamma_digest) {
      throw new Error("Decide_Q overlay base_state identity mismatch");
    }
    return;
  }
  if (typeof baseState !== "object" || baseState === null || Array.isArray(baseState)) {
    throw new Error("Decide_Q overlay base_state identity mismatch");
  }
  const record = baseState as Readonly<Record<string, FiniteValue>>;
  const expected = queryProofDecideBaseState(world) as Readonly<Record<string, FiniteValue>>;
  const keys = Object.keys(record).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index] || record[key] !== expected[key])) {
    throw new Error("Decide_Q overlay base_state identity mismatch");
  }
}

function applyAssignment(
  assignment: FiniteConcreteRefinement["assignments"][number],
  candidates: readonly ShadowCaptureWalkCandidate[],
  evidence: readonly QueryGammaCandidateEvidenceV1[],
  bindings: Array<QueryProofDecideWorldV1["answer_bindings"][number]>,
  candidateIdentityByDigest: Readonly<Record<string, string>>
): {
  readonly candidates: readonly ShadowCaptureWalkCandidate[];
  readonly evidence: readonly QueryGammaCandidateEvidenceV1[];
} {
  if (assignment.kind === "candidate_membership") {
    if (!candidates.some((row) => row.candidate_key === assignment.owner_id)) {
      throw new Error("Decide_Q cannot materialize an unbounded hidden candidate");
    }
    if (assignment.value !== false) return { candidates, evidence };
    return {
      candidates: candidates.filter((row) => row.candidate_key !== assignment.owner_id),
      evidence: evidence.filter((row) => row.candidate_key !== assignment.owner_id)
    };
  }
  if (assignment.kind === "answer_binding") {
    if (typeof assignment.value !== "string") {
      throw new Error("Decide_Q answer binding must be a semantic identity");
    }
    const owner = assignment.owner_id;
    if (!candidates.some((row) => row.candidate_key === owner)) {
      throw new Error("Decide_Q answer binding owner is outside the candidate universe");
    }
    const index = bindings.findIndex((row) =>
      row.candidate_key === owner && row.binding_id === assignment.coordinate_id);
    if (index < 0) throw new Error("Decide_Q answer binding coordinate is unknown");
    const current = bindings[index]!;
    const next = Object.freeze({
      candidate_key: owner,
      binding_id: assignment.coordinate_id,
      variable: current.variable,
      semantic_identity: assignment.value,
      value: assignment.value
    });
    bindings[index] = next;
    return {
      candidates,
      evidence: overlayBinding(evidence, owner, current, assignment.value)
    };
  }
  if (assignment.kind === "identity_tie") {
    const winner = candidateIdentityByDigest[String(assignment.value)];
    if (winner === undefined) {
      throw new Error("Decide_Q identity-tie winner is outside the captured universe");
    }
    return {
      candidates: candidates.filter((row) => row.candidate_key === winner),
      evidence: evidence.filter((row) => row.candidate_key === winner)
    };
  }
  if (assignment.kind === "correlation_state") {
    return {
      candidates,
      evidence: overlayIndependence(
        evidence, assignment.owner_id, assignment.coordinate_id, assignment.value
      )
    };
  }
  if (assignment.kind === "proposition_conflict") {
    return {
      candidates,
      evidence: overlayProposition(
        evidence, assignment.owner_id, assignment.coordinate_id, assignment.value
      )
    };
  }
  throw new Error(`Decide_Q cannot apply remaining effect ${assignment.kind}`);
}

function overlayIndependence(
  evidence: readonly QueryGammaCandidateEvidenceV1[],
  ownerId: string,
  coordinateId: string,
  value: FiniteValue
): readonly QueryGammaCandidateEvidenceV1[] {
  const independence = value === "unknown"
    ? "unknown" as const
    : value === "different_group"
      ? "certified_independent" as const
      : "correlated" as const;
  return evidence.map((row) => {
    if (row.candidate_key !== ownerId) return row;
    const matches = row.propositions.filter((proposition) =>
      proposition.proposition_id === coordinateId);
    if (matches.length !== 1) {
      throw new Error("Decide_Q correlation coordinate is not uniquely owner-bound");
    }
    return Object.freeze({
      ...row,
      propositions: Object.freeze(row.propositions.map((proposition) =>
        proposition.proposition_id === coordinateId
          ? Object.freeze({ ...proposition, independence })
          : proposition))
    });
  });
}

function overlayProposition(
  evidence: readonly QueryGammaCandidateEvidenceV1[],
  ownerId: string,
  propositionId: string,
  value: FiniteValue
): readonly QueryGammaCandidateEvidenceV1[] {
  if (value === "both") {
    throw new Error("Decide_Q cannot soundly encode a four-valued both proposition");
  }
  const support = value === "supported_only"
    ? "supports" as const
    : value === "unknown"
      ? "unknown" as const
      : "refutes" as const;
  return evidence.map((row) => {
    if (row.candidate_key !== ownerId) return row;
    const matches = row.propositions.filter((proposition) =>
      proposition.proposition_id === propositionId);
    if (matches.length !== 1) {
      throw new Error("Decide_Q proposition coordinate is not uniquely owner-bound");
    }
    return Object.freeze({
      ...row,
      propositions: Object.freeze(row.propositions.map((proposition) =>
        proposition.proposition_id === propositionId
          ? Object.freeze({ ...proposition, support })
          : proposition))
    });
  });
}

function overlayBinding(
  evidence: readonly QueryGammaCandidateEvidenceV1[],
  ownerId: string,
  current: QueryProofDecideWorldV1["answer_bindings"][number],
  semanticIdentity: string
): readonly QueryGammaCandidateEvidenceV1[] {
  return evidence.map((row) => {
    if (row.candidate_key !== ownerId) return row;
    const matches = row.bindings.filter((binding) =>
      binding.variable === current.variable &&
      binding.semantic_identity === current.semantic_identity);
    if (matches.length !== 1) {
      throw new Error("Decide_Q binding evidence is not uniquely owner-bound");
    }
    return Object.freeze({
      ...row,
      bindings: Object.freeze(row.bindings.map((binding) =>
        binding.variable === current.variable &&
        binding.semantic_identity === current.semantic_identity
          ? Object.freeze({ ...binding, semantic_identity: semanticIdentity })
          : binding))
    });
  });
}

function applySemanticOverrides(
  compiled: ReturnType<typeof projectCompiledToCandidateKeys>,
  overrides: ReadonlyMap<string, "feasible" | "infeasible">
): ReturnType<typeof projectCompiledToCandidateKeys> {
  if (overrides.size === 0) return compiled;
  return Object.freeze({
    ...compiled,
    semantic_feasibility: Object.freeze(compiled.semantic_feasibility.map((row) => {
      const semantic = overrides.get(row.candidate_key);
      return semantic === undefined ? row : Object.freeze({ ...row, semantic });
    }))
  });
}
