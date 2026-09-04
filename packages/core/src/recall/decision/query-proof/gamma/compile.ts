import { compareText } from "../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from "../../../field/field-identity.js";
import type { RecallFieldDigest } from "../../../field/field-identity.js";
import {
  digestCanonicalQueryV1,
  type CanonicalAnswerProgramV1,
  type CanonicalCompletionV1,
  type CanonicalQueryCompilationV1,
  type CanonicalQueryV1
} from "../../../query/canonical-query/index.js";
import { ShadowContractError } from "../../contract-primitives.js";
import { type ExtremumClosureWitness } from "../closure/extremum.js";
import { extremaRequirement } from "./extrema-witness.js";
import {
  answerProgramCapabilityId,
  queryClassCapabilityStatus,
  type QueryClassSourceEvidenceV1
} from "./capability-matrix.js";
import {
  assertExactGammaKeys,
  assertUniqueGammaAtomIds,
  captureGammaPremises,
  createGammaAtom,
  DEFAULT_RESOURCE_FEASIBILITY_POLICY,
  digestQueryGammaBody,
  isIndependentSupportToken,
  QUERY_PROOF_GAMMA_OPERATOR_ID,
  rejectForbiddenGammaKeys,
  sortGammaAtoms,
  type QueryCompiledGammaV1,
  type QueryGammaAtomJurisdictionV1,
  type QueryGammaAtomV1,
  type QueryGammaCandidateEvidenceV1,
  type QueryGammaCandidateFeasibilityV1,
  type QueryGammaClassifiedHoleV1,
  type QueryGammaCompileDispositionV1,
  type QueryGammaSealObligationV1,
  type QueryGammaStandingV1,
  type ResourceFeasibilityPolicyV1
} from "./contract.js";
import { compiledGammaUniverseMismatch, firstDuplicate } from "./candidate-universe.js";
import {
  evaluateSemanticFeasibility,
  standingForAtom
} from "./evaluate.js";

const COMPILE_INPUT_KEYS = [
  "compilation",
  "candidates",
  "extremum_witness",
  "resource_policy",
  "hypothesis_digest",
  "class_source"
] as const;

const CANDIDATE_EVIDENCE_KEYS = [
  "candidate_key",
  "object_key",
  "token_cost",
  "dimension",
  "bindings_status",
  "bindings",
  "propositions_status",
  "propositions",
  "sequence_slots",
  "extremal_bindings"
] as const;

export type QueryGammaCompileInputV1 = Readonly<{
  readonly compilation: CanonicalQueryCompilationV1;
  readonly candidates: readonly QueryGammaCandidateEvidenceV1[];
  readonly extremum_witness?: ExtremumClosureWitness | null;
  readonly resource_policy?: ResourceFeasibilityPolicyV1;
  readonly hypothesis_digest?: RecallFieldDigest;
  readonly class_source?: QueryClassSourceEvidenceV1;
}>;

export function compileQueryGamma(
  input: QueryGammaCompileInputV1
): QueryCompiledGammaV1 {
  const captured = captureGammaPremises(input);
  assertCompileInput(captured);
  const compilation = captured.compilation;
  const query = selectHypothesis(compilation, captured.hypothesis_digest);
  const resourcePolicy = captured.resource_policy ?? DEFAULT_RESOURCE_FEASIBILITY_POLICY;
  const holes = classifiedHoles(compilation, captured.hypothesis_digest);
  if (query === null) {
    const missing = compilation.hypotheses.length > 1 && captured.hypothesis_digest === undefined
      ? "multiple_hypotheses"
      : "no_accepted_answer_program";
    return unsupportedGamma(compilation, resourcePolicy, missing, holes);
  }
  const blocked = blockedOperatorReason(compilation, holes);
  if (blocked !== null) {
    return unsupportedGamma(compilation, resourcePolicy, blocked, holes);
  }
  const candidates = captured.candidates;
  const classReason = unsupportedAnswerClassReason(query.answer, captured.class_source);
  if (classReason !== null) {
    return unsupportedGamma(compilation, resourcePolicy, classReason, holes);
  }
  const illegalSlots = illegalSequenceReason(query.answer, candidates);
  if (illegalSlots !== null) {
    return unsupportedGamma(compilation, resourcePolicy, illegalSlots, holes);
  }
  const witness = captured.extremum_witness ?? null;
  const extrema = extremaRequirement(
    query.answer, witness, compilation, query, candidates
  );
  if (extrema.status === "unsupported") {
    return unsupportedGamma(compilation, resourcePolicy, extrema.reason, holes);
  }
  const obligation = hasIndependentSupportObligation(query, compilation);
  const atoms = sortGammaAtoms([
    ...answerAtoms(query.answer, candidates, extrema.binding_ids),
    ...propositionAtoms(query),
    ...independentAtoms(query, compilation, obligation)
  ]);
  assertUniqueGammaAtomIds(atoms);
  const standings = compileStandings(atoms, candidates);
  const feasibility = candidates.map((candidate) => Object.freeze({
    candidate_key: candidate.candidate_key,
    semantic: evaluateSemanticFeasibility(atoms, candidate)
  }));
  const compiled = sealCompiledGamma({
    compilation,
    query,
    resourcePolicy,
    obligation,
    atoms,
    standings,
    feasibility,
    seal_obligations: sealObligations(query.answer),
    compile_disposition: holes.some((hole) => hole.impacts.includes("blocks_certified_delivery"))
      ? "partial"
      : "complete",
    classified_holes: holes,
    source_evidence_digest: digestRecallFieldIdentity({
      kind: "query_gamma_source_evidence_v1",
      candidates: [...candidates].sort((left, right) =>
        compareText(left.candidate_key, right.candidate_key)).map((candidate) => Object.freeze({
        candidate_key: candidate.candidate_key,
        bindings_status: candidate.bindings_status,
        propositions_status: candidate.propositions_status
      }))
    })
  });
  const universe = compiledGammaUniverseMismatch(
    candidates.map((candidate) => candidate.candidate_key),
    compiled
  );
  if (universe !== null) {
    throw new ShadowContractError(universe);
  }
  return compiled;
}

function assertCompileInput(input: QueryGammaCompileInputV1): void {
  rejectForbiddenGammaKeys(input, "query gamma compile input");
  const allowed = new Set<string>(COMPILE_INPUT_KEYS);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new ShadowContractError(
      `query gamma compile input has unknown fields: ${extra.join(",")}`
    );
  }
  input.candidates.forEach(assertCandidateEvidence);
  if (firstDuplicate(input.candidates.map((candidate) => candidate.candidate_key)) !== null) {
    throw new ShadowContractError("duplicate compile-input candidate_key");
  }
  if (input.resource_policy !== undefined) {
    assertExactGammaKeys(input.resource_policy, [
      "schema_version", "reject_duplicate_object", "token_budget", "per_dimension_limits"
    ], "resource feasibility policy");
    if (input.resource_policy.reject_duplicate_object !== true) {
      throw new ShadowContractError("resource feasibility must keep object-identity dedupe");
    }
  }
}

function assertCandidateEvidence(candidate: QueryGammaCandidateEvidenceV1): void {
  assertExactGammaKeys(candidate, CANDIDATE_EVIDENCE_KEYS, "query gamma candidate evidence");
  candidate.bindings.forEach((binding) => assertExactGammaKeys(binding, [
    "variable", "semantic_identity", "distinctness"
  ], "query gamma binding evidence"));
  candidate.propositions.forEach((proposition) => assertExactGammaKeys(proposition, [
    "proposition_id", "jurisdiction", "support", "independence"
  ], "query gamma proposition evidence"));
  candidate.sequence_slots.forEach((slot) => assertExactGammaKeys(slot, [
    "position", "binding"
  ], "query gamma sequence slot"));
}

function selectHypothesis(
  compilation: CanonicalQueryCompilationV1,
  digest: RecallFieldDigest | undefined
): CanonicalQueryV1 | null {
  if (compilation.hypotheses.length !== 1 && digest === undefined) return null;
  if (digest === undefined) return compilation.hypotheses[0] ?? null;
  return compilation.hypotheses.find((query) => digestCanonicalQueryV1(query) === digest)
    ?? null;
}

function classifiedHoles(
  compilation: CanonicalQueryCompilationV1,
  selectedHypothesisDigest: RecallFieldDigest | undefined
): readonly QueryGammaClassifiedHoleV1[] {
  return Object.freeze(compilation.holes
    .filter((hole) => hole.hypothesis_digest === undefined ||
      hole.hypothesis_digest === selectedHypothesisDigest)
    .map((hole) => Object.freeze({
      provenance: hole.provenance,
      code: hole.code,
      impacts: Object.freeze([...hole.impacts]),
      ...(hole.hypothesis_digest === undefined ? {} : { hypothesis_digest: hole.hypothesis_digest })
    })));
}

function blockedOperatorReason(
  compilation: CanonicalQueryCompilationV1,
  holes: readonly QueryGammaClassifiedHoleV1[]
): string | null {
  if (compilation.compile_status === "unsupported") return "canonical_query_unsupported";
  if (compilation.hypotheses.length === 0) return "no_accepted_answer_program";
  if (holes.some((hole) => hole.impacts.includes("blocks_operator_resolution") ||
    hole.impacts.includes("blocks_all_delivery"))) {
    return "operator_resolution_blocked";
  }
  return null;
}

function unsupportedAnswerClassReason(
  answer: CanonicalAnswerProgramV1,
  source: QueryClassSourceEvidenceV1 | undefined
): string | null {
  const capability = answerProgramCapabilityId(answer.kind);
  const status = queryClassCapabilityStatus(capability, source);
  if (status.supported_in_shadow) return null;
  return status.unsupported_reason ?? `${capability}_unsupported`;
}

function hasIndependentSupportObligation(
  query: CanonicalQueryV1,
  compilation: CanonicalQueryCompilationV1
): boolean {
  // Translate existing Phi tokens and sensitivity targets. Relation/constraint
  // strings are already unconstrained in Q_q, so this does not invent a new
  // production.
  if (query.predicates.some((predicate) => isIndependentSupportToken(predicate.relation)) ||
    query.constraints.some((constraint) => isIndependentSupportToken(constraint.constraint))) {
    return true;
  }
  return compilation.sensitivities.some((row) => isIndependentSupportToken(row.target));
}

function answerAtoms(
  answer: CanonicalAnswerProgramV1,
  candidates: readonly QueryGammaCandidateEvidenceV1[],
  extremalBindings: readonly string[]
): QueryGammaAtomV1[] {
  if (answer.kind === "scalar") {
    return [createGammaAtom({
      stratum: "answer_binding_position",
      kind: "scalar_binding",
      target: answer.variable,
      variable: answer.variable
    })];
  }
  if (answer.kind === "distinct") {
    return distinctAtoms(answer.variable, candidates);
  }
  if (answer.kind === "sequence") {
    return sequenceAtoms(candidates);
  }
  return [
    ...extremalBindings.map((binding) => createGammaAtom({
      stratum: "answer_binding_position",
      kind: "extremum_binding",
      target: binding,
      semantic_identity: binding
    })),
    ...answerAtoms(answer.inner, candidates, extremalBindings)
  ];
}

function distinctAtoms(
  variable: string,
  candidates: readonly QueryGammaCandidateEvidenceV1[]
): QueryGammaAtomV1[] {
  const identities = new Set<string>();
  for (const candidate of candidates) {
    for (const binding of candidate.bindings) {
      if (binding.variable !== variable) continue;
      identities.add(binding.semantic_identity);
    }
  }
  return [...identities].sort(compareText).map((identity) =>
    createGammaAtom({
      stratum: "answer_binding_position",
      kind: "distinct_binding",
      target: identity,
      variable,
      semantic_identity: identity
    }));
}

function sequenceAtoms(
  candidates: readonly QueryGammaCandidateEvidenceV1[]
): QueryGammaAtomV1[] {
  const slots = new Map<string, QueryGammaAtomV1>();
  for (const candidate of candidates) {
    for (const slot of candidate.sequence_slots) {
      const gammaAtom = createGammaAtom({
        stratum: "answer_binding_position",
        kind: "sequence_slot",
        target: slot.binding,
        position: slot.position
      });
      slots.set(gammaAtom.atom_id, gammaAtom);
    }
  }
  return [...slots.values()];
}

function illegalSequenceReason(
  answer: CanonicalAnswerProgramV1,
  candidates: readonly QueryGammaCandidateEvidenceV1[]
): string | null {
  if (answer.kind === "argmax" || answer.kind === "argmin") {
    return illegalSequenceReason(answer.inner, candidates);
  }
  if (answer.kind !== "sequence") return null;
  const limit = answer.completion.kind === "at_most" ? answer.completion.n : Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    for (const slot of candidate.sequence_slots) {
      if (!Number.isInteger(slot.position) || slot.position < 0 || slot.position >= limit) {
        return "illegal_sequence_slot";
      }
    }
  }
  return null;
}

function propositionAtoms(query: CanonicalQueryV1): QueryGammaAtomV1[] {
  return phiAtoms(query)
    .filter((row) => !isIndependentSupportToken(row.token))
    .map((row) => createGammaAtom({
      stratum: "required_proposition_support",
      kind: "required_proposition",
      target: row.id,
      jurisdiction: row.jurisdiction
    }));
}

function independentAtoms(
  query: CanonicalQueryV1,
  compilation: CanonicalQueryCompilationV1,
  obligation: boolean
): QueryGammaAtomV1[] {
  if (!obligation) return [];
  const seen = new Set<string>();
  const rows: QueryGammaAtomV1[] = [];
  for (const row of phiAtoms(query)) {
    if (!isIndependentSupportToken(row.token)) continue;
    const gammaAtom = createGammaAtom({
      stratum: "certified_independent_support",
      kind: "certified_independent_support",
      target: row.id,
      jurisdiction: row.jurisdiction
    });
    if (seen.has(gammaAtom.atom_id)) continue;
    seen.add(gammaAtom.atom_id);
    rows.push(gammaAtom);
  }
  for (const row of compilation.sensitivities) {
    if (!isIndependentSupportToken(row.target)) continue;
    const gammaAtom = createGammaAtom({
      stratum: "certified_independent_support",
      kind: "certified_independent_support",
      target: row.target,
      jurisdiction: "sensitivity",
      semantic_identity: row.effect
    });
    if (seen.has(gammaAtom.atom_id)) continue;
    seen.add(gammaAtom.atom_id);
    rows.push(gammaAtom);
  }
  return rows;
}

function phiAtoms(query: CanonicalQueryV1): readonly Readonly<{
  readonly id: string;
  readonly token: string;
  readonly arguments: readonly string[];
  readonly jurisdiction: QueryGammaAtomJurisdictionV1;
}>[] {
  return [
    ...query.predicates.map((predicate) => ({
      id: predicate.id,
      token: predicate.relation,
      arguments: predicate.arguments,
      jurisdiction: "predicate" as const
    })),
    ...query.constraints.map((constraint) => ({
      id: constraint.id,
      token: constraint.constraint,
      arguments: constraint.arguments,
      jurisdiction: "constraint" as const
    }))
  ];
}

function sealObligations(answer: CanonicalAnswerProgramV1): readonly QueryGammaSealObligationV1[] {
  const rows: QueryGammaSealObligationV1[] = [];
  collectSeal(answer, rows);
  return Object.freeze(rows.sort((left, right) => compareText(left.target, right.target)));
}

function collectSeal(
  answer: CanonicalAnswerProgramV1,
  rows: QueryGammaSealObligationV1[]
): void {
  if (answer.kind === "argmax" || answer.kind === "argmin") {
    collectSeal(answer.inner, rows);
    return;
  }
  if (answer.kind !== "distinct" && answer.kind !== "sequence") return;
  pushObservable(answer.completion, rows);
}

function pushObservable(
  completion: CanonicalCompletionV1,
  rows: QueryGammaSealObligationV1[]
): void {
  if (completion.kind !== "all_observable") return;
  rows.push(Object.freeze({
    kind: "all_observable" as const,
    target: `${completion.scope}:${completion.observer_contract}`
  }));
}

function compileStandings(
  atoms: readonly QueryGammaAtomV1[],
  candidates: readonly QueryGammaCandidateEvidenceV1[]
): readonly QueryGammaStandingV1[] {
  const rows: QueryGammaStandingV1[] = [];
  for (const candidate of [...candidates].sort((left, right) =>
    compareText(left.candidate_key, right.candidate_key))) {
    for (const gammaAtom of atoms) {
      rows.push(standingForAtom(gammaAtom, candidate));
    }
  }
  return Object.freeze(rows);
}

function sealCompiledGamma(params: Readonly<{
  readonly compilation: CanonicalQueryCompilationV1;
  readonly query: CanonicalQueryV1;
  readonly resourcePolicy: ResourceFeasibilityPolicyV1;
  readonly obligation: boolean;
  readonly atoms: readonly QueryGammaAtomV1[];
  readonly standings: readonly QueryGammaStandingV1[];
  readonly feasibility: readonly QueryGammaCandidateFeasibilityV1[];
  readonly seal_obligations: readonly QueryGammaSealObligationV1[];
  readonly compile_disposition: QueryGammaCompileDispositionV1;
  readonly classified_holes: readonly QueryGammaClassifiedHoleV1[];
  readonly source_evidence_digest: RecallFieldDigest;
}>): QueryCompiledGammaV1 {
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_PROOF_GAMMA_OPERATOR_ID,
    compile_status: "compiled" as const,
    compile_disposition: params.compile_disposition,
    classified_holes: params.classified_holes,
    unsupported_reason: null,
    query_digest: digestCanonicalQueryV1(params.query),
    compilation_digest: params.compilation.digest,
    independent_support_obligation: params.obligation,
    resource_policy: params.resourcePolicy,
    seal_obligations: params.seal_obligations,
    atoms: params.atoms,
    standings: params.standings,
    semantic_feasibility: Object.freeze(
      [...params.feasibility].sort((left, right) =>
        compareText(left.candidate_key, right.candidate_key))
    ),
    source_evidence_digest: params.source_evidence_digest
  });
  return Object.freeze({
    ...body,
    gamma_digest: digestQueryGammaBody(queryOwnedGamma(body))
  });
}

function unsupportedGamma(
  compilation: CanonicalQueryCompilationV1,
  resourcePolicy: ResourceFeasibilityPolicyV1,
  reason: string,
  holes: readonly QueryGammaClassifiedHoleV1[] = Object.freeze([])
): QueryCompiledGammaV1 {
  const queryDigest = compilation.hypotheses[0] === undefined
    ? digestRecallFieldIdentity({ operator_id: "unsupported_query_gamma" })
    : digestCanonicalQueryV1(compilation.hypotheses[0]);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_PROOF_GAMMA_OPERATOR_ID,
    compile_status: "unsupported" as const,
    compile_disposition: "unsupported" as const,
    classified_holes: holes,
    unsupported_reason: reason,
    query_digest: queryDigest,
    compilation_digest: compilation.digest,
    independent_support_obligation: false,
    resource_policy: resourcePolicy,
    seal_obligations: Object.freeze([] as QueryGammaSealObligationV1[]),
    atoms: Object.freeze([] as QueryGammaAtomV1[]),
    standings: Object.freeze([] as QueryGammaStandingV1[]),
    semantic_feasibility: Object.freeze([] as QueryGammaCandidateFeasibilityV1[]),
    source_evidence_digest: null
  });
  return Object.freeze({
    ...body,
    gamma_digest: digestQueryGammaBody(queryOwnedGamma(body))
  });
}

export function compiledGammaBodyDigest(
  compiled: QueryCompiledGammaV1
): RecallFieldDigest {
  const { gamma_digest: _digest, ...body } = compiled;
  return digestQueryGammaBody(queryOwnedGamma(body));
}

function queryOwnedGamma(
  body: Omit<QueryCompiledGammaV1, "gamma_digest">
): Omit<QueryCompiledGammaV1, "gamma_digest" | "standings" | "semantic_feasibility"> {
  const {
    standings: _standings,
    semantic_feasibility: _feasibility,
    ...owned
  } = body;
  return owned;
}

export type { QueryGammaCandidateEvidenceV1 };
export {
  extremumClosureDigest,
  extremumPrincipalDigest,
  extremumUniverseDigest
} from "./extrema-witness.js";
