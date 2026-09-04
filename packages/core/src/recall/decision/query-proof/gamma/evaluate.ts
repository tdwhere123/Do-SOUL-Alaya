import { compareText } from "../../../../shared/compare-text.js";
import { ShadowContractError } from "../../contract-primitives.js";
import { firstDuplicate } from "./candidate-universe.js";
import {
  isExecutableCompiledGamma,
  stratumIndex,
  type QueryCompiledGammaTupleV1,
  type QueryCompiledGammaV1,
  type QueryGammaAtomV1,
  type QueryGammaAdmissionStatusV1,
  type QueryGammaCandidateEvidenceV1,
  type QueryGammaCoverageV1,
  type QueryGammaIndependenceV1,
  type QueryGammaPropositionEvidenceV1,
  type QueryGammaStandingV1,
  type SemanticFeasibilityV1
} from "./contract.js";

export type QueryGammaSelectedSetV1 = Readonly<{
  readonly covered_atom_ids: ReadonlySet<string>;
  readonly object_keys: ReadonlySet<string>;
  readonly used_tokens: number;
  readonly dim_count: ReadonlyMap<string, number>;
}>;

export type QueryGammaAdmissionV1 = Readonly<{
  readonly admitted: boolean;
  readonly status: QueryGammaAdmissionStatusV1;
  readonly compiled_atom_ids: readonly string[];
}>;

export function emptyQueryGammaSelectedSet(): QueryGammaSelectedSetV1 {
  return {
    covered_atom_ids: new Set(),
    object_keys: new Set(),
    used_tokens: 0,
    dim_count: new Map()
  };
}

export function standingForAtom(
  gammaAtom: QueryGammaAtomV1,
  candidate: QueryGammaCandidateEvidenceV1
): QueryGammaStandingV1 {
  return Object.freeze({
    candidate_key: candidate.candidate_key,
    atom_id: gammaAtom.atom_id,
    coverage: coverageFor(gammaAtom, candidate),
    independence: independenceFor(gammaAtom, candidate)
  });
}

export function evaluateSemanticFeasibility(
  atoms: readonly QueryGammaAtomV1[],
  candidate: QueryGammaCandidateEvidenceV1
): SemanticFeasibilityV1 {
  const standings = atoms.map((gammaAtom) => standingForAtom(gammaAtom, candidate));
  if (atoms.some((gammaAtom) => propositionAtomRefuted(gammaAtom, candidate))) {
    return "infeasible";
  }
  if (candidate.bindings_status === "unknown") return "unresolved";
  const unresolved = atoms.some((gammaAtom, index) =>
    standings[index]?.coverage === "unknown" &&
    gammaAtom.kind !== "certified_independent_support");
  if (unresolved) return "unresolved";
  return "feasible";
}

export function evaluateQueryGammaTuple(
  compiled: QueryCompiledGammaV1,
  selected: QueryGammaSelectedSetV1,
  candidateKey: string
): QueryCompiledGammaTupleV1 {
  refuseUnsupportedGamma(compiled);
  const counts = {
    answer_binding_position: 0,
    required_proposition_support: 0,
    certified_independent_support: 0
  };
  for (const standing of standingsOf(compiled, candidateKey)) {
    if (standing.coverage !== "covers") continue;
    if (selected.covered_atom_ids.has(standing.atom_id)) continue;
    if (independentAtom(compiled, standing.atom_id) &&
      standing.independence !== "certified_independent") continue;
    counts[stratumOf(compiled, standing.atom_id)] += 1;
  }
  if (!compiled.independent_support_obligation) {
    counts.certified_independent_support = 0;
  }
  return Object.freeze(counts);
}

export function admitCompiledLowerFrontier(
  compiled: QueryCompiledGammaV1,
  selected: QueryGammaSelectedSetV1,
  candidateKey: string,
  higherEligibleKeys: readonly string[]
): QueryGammaAdmissionV1 {
  refuseUnsupportedGamma(compiled);
  const novel = novelCoveredAtoms(compiled, selected, candidateKey);
  const admitted: string[] = [];
  let unresolvedVsHigher = false;
  for (const atomId of novel) {
    const coverages = higherEligibleKeys.map((higherKey) =>
      standingCoverage(compiled, higherKey, atomId));
    if (coverages.some((coverage) => coverage === "unknown")) {
      unresolvedVsHigher = true;
      continue;
    }
    if (coverages.every((coverage) => coverage === "does_not_cover")) {
      admitted.push(atomId);
    }
  }
  const higherStratum = admitted.filter((atomId) =>
    stratumIndex(stratumOf(compiled, atomId)) <
    stratumIndex("certified_independent_support"));
  const unknownAboveGain = hasUnknownStrictlyHigherStanding(
    compiled, candidateKey, higherStratum);
  const status: QueryGammaAdmissionStatusV1 =
    higherStratum.length > 0 && !unknownAboveGain
      ? "admitted"
      : unresolvedVsHigher || unknownAboveGain
        ? "unresolved"
        : "denied";
  return Object.freeze({
    admitted: status === "admitted",
    status,
    compiled_atom_ids: Object.freeze([...higherStratum].sort(compareText))
  });
}

export function novelQueryGammaAtomIds(
  compiled: QueryCompiledGammaV1,
  selected: QueryGammaSelectedSetV1,
  candidateKey: string
): readonly string[] {
  refuseUnsupportedGamma(compiled);
  return Object.freeze([...novelCoveredAtoms(compiled, selected, candidateKey)]
    .sort(compareText));
}

export function acceptQueryGammaCandidate(
  selected: QueryGammaSelectedSetV1,
  compiled: QueryCompiledGammaV1,
  candidateKey: string,
  objectKey: string,
  tokenCost: number,
  dimension: string
): QueryGammaSelectedSetV1 {
  refuseUnsupportedGamma(compiled);
  const covered = new Set(selected.covered_atom_ids);
  for (const standing of standingsOf(compiled, candidateKey)) {
    if (standing.coverage !== "covers") continue;
    if (independentAtom(compiled, standing.atom_id) &&
      standing.independence !== "certified_independent") continue;
    covered.add(standing.atom_id);
  }
  const objectKeys = new Set(selected.object_keys);
  objectKeys.add(objectKey);
  const dimCount = new Map(selected.dim_count);
  dimCount.set(dimension, (dimCount.get(dimension) ?? 0) + 1);
  return {
    covered_atom_ids: covered,
    object_keys: objectKeys,
    used_tokens: selected.used_tokens + tokenCost,
    dim_count: dimCount
  };
}

export function semanticFeasibilityMap(
  compiled: QueryCompiledGammaV1
): ReadonlyMap<string, SemanticFeasibilityV1> {
  if (firstDuplicate(compiled.semantic_feasibility.map((row) => row.candidate_key)) !== null) {
    throw new ShadowContractError("duplicate compiled feasibility candidate_key");
  }
  return new Map(compiled.semantic_feasibility.map((row) => [row.candidate_key, row.semantic]));
}

export function provedInfeasibleCandidateKeys(
  compiled: QueryCompiledGammaV1
): ReadonlySet<string> {
  if (firstDuplicate(compiled.semantic_feasibility.map((row) => row.candidate_key)) !== null) {
    throw new ShadowContractError("duplicate compiled feasibility candidate_key");
  }
  return new Set(compiled.semantic_feasibility
    .filter((row) => row.semantic === "infeasible")
    .map((row) => row.candidate_key));
}

export function provedFeasibleCandidateKeys(
  compiled: QueryCompiledGammaV1
): ReadonlySet<string> {
  if (firstDuplicate(compiled.semantic_feasibility.map((row) => row.candidate_key)) !== null) {
    throw new ShadowContractError("duplicate compiled feasibility candidate_key");
  }
  return new Set(compiled.semantic_feasibility
    .filter((row) => row.semantic === "feasible")
    .map((row) => row.candidate_key));
}

function refuseUnsupportedGamma(compiled: QueryCompiledGammaV1): void {
  if (!isExecutableCompiledGamma(compiled)) {
    throw new ShadowContractError("unsupported Gamma cannot be scored as a zero tuple");
  }
}

function coverageFor(
  gammaAtom: QueryGammaAtomV1,
  candidate: QueryGammaCandidateEvidenceV1
): QueryGammaCoverageV1 {
  if (gammaAtom.kind === "scalar_binding") {
    if (candidate.bindings_status === "unknown") return "unknown";
    return candidate.bindings.some((binding) => binding.variable === gammaAtom.target)
      ? "covers"
      : "does_not_cover";
  }
  if (gammaAtom.kind === "distinct_binding") {
    return bindingCoverage(candidate, gammaAtom);
  }
  if (gammaAtom.kind === "sequence_slot") {
    if (gammaAtom.position === undefined) {
      throw new ShadowContractError("sequence atom missing position");
    }
    if (candidate.bindings_status === "unknown") return "unknown";
    return candidate.sequence_slots.some((slot) =>
      slot.position === gammaAtom.position && slot.binding === gammaAtom.target)
      ? "covers"
      : "does_not_cover";
  }
  if (gammaAtom.kind === "extremum_binding") {
    if (candidate.bindings_status === "unknown") return "unknown";
    return candidate.extremal_bindings.includes(gammaAtom.target) ||
      candidate.bindings.some((binding) => binding.semantic_identity === gammaAtom.target)
      ? "covers"
      : "does_not_cover";
  }
  return propositionCoverage(gammaAtom, candidate);
}

function propositionAtomRefuted(
  gammaAtom: QueryGammaAtomV1,
  candidate: QueryGammaCandidateEvidenceV1
): boolean {
  if (gammaAtom.kind !== "required_proposition" &&
    gammaAtom.kind !== "certified_independent_support") {
    return false;
  }
  return candidate.propositions.some((proposition) =>
    matchesProposition(gammaAtom, proposition) &&
    proposition.support === "refutes");
}

function propositionCoverage(
  gammaAtom: QueryGammaAtomV1,
  candidate: QueryGammaCandidateEvidenceV1
): QueryGammaCoverageV1 {
  if (candidate.propositions_status === "unknown") return "unknown";
  const match = candidate.propositions.find((proposition) =>
    matchesProposition(gammaAtom, proposition));
  if (match === undefined) return "does_not_cover";
  if (match.support === "unknown") return "unknown";
  if (match.support === "refutes") return "does_not_cover";
  if (gammaAtom.kind === "certified_independent_support") {
    if (match.independence === "unknown") return "unknown";
    return match.support === "supports" && match.independence === "certified_independent"
      ? "covers"
      : "does_not_cover";
  }
  return match.support === "supports" ? "covers" : "does_not_cover";
}

function bindingCoverage(
  candidate: QueryGammaCandidateEvidenceV1,
  gammaAtom: QueryGammaAtomV1
): QueryGammaCoverageV1 {
  if (candidate.bindings_status === "unknown") return "unknown";
  if (gammaAtom.variable === undefined || gammaAtom.semantic_identity === undefined) {
    throw new ShadowContractError("distinct atom missing variable or semantic identity");
  }
  const hits = candidate.bindings.filter((binding) =>
    binding.semantic_identity === gammaAtom.semantic_identity &&
    binding.variable === gammaAtom.variable);
  if (hits.some((binding) => binding.distinctness !== "proved_distinct")) return "unknown";
  return hits.some((binding) => binding.distinctness === "proved_distinct")
    ? "covers"
    : "does_not_cover";
}

function independenceFor(
  gammaAtom: QueryGammaAtomV1,
  candidate: QueryGammaCandidateEvidenceV1
): QueryGammaIndependenceV1 {
  if (gammaAtom.kind !== "certified_independent_support") return "not_applicable";
  if (candidate.propositions_status === "unknown") return "unknown";
  const match = candidate.propositions.find((proposition) =>
    matchesProposition(gammaAtom, proposition));
  return match?.independence ?? "unknown";
}

function matchesProposition(
  gammaAtom: QueryGammaAtomV1,
  proposition: QueryGammaPropositionEvidenceV1
): boolean {
  return proposition.proposition_id === gammaAtom.target &&
    proposition.jurisdiction === gammaAtom.jurisdiction;
}

function novelCoveredAtoms(
  compiled: QueryCompiledGammaV1,
  selected: QueryGammaSelectedSetV1,
  candidateKey: string
): readonly string[] {
  return standingsOf(compiled, candidateKey)
    .filter((standing) => standing.coverage === "covers" &&
      !selected.covered_atom_ids.has(standing.atom_id) &&
      (standing.independence === "certified_independent" ||
        !independentAtom(compiled, standing.atom_id)))
    .map((standing) => standing.atom_id);
}

function independentAtom(compiled: QueryCompiledGammaV1, atomId: string): boolean {
  return compiled.atoms.find((row) => row.atom_id === atomId)?.kind ===
    "certified_independent_support";
}

function standingCoverage(
  compiled: QueryCompiledGammaV1,
  candidateKey: string,
  atomId: string
): QueryGammaCoverageV1 {
  const standing = standingsOf(compiled, candidateKey)
    .find((row) => row.atom_id === atomId);
  return standing?.coverage ?? "unknown";
}

function standingsOf(
  compiled: QueryCompiledGammaV1,
  candidateKey: string
): readonly QueryGammaStandingV1[] {
  return compiled.standings.filter((row) => row.candidate_key === candidateKey);
}

function hasUnknownStrictlyHigherStanding(
  compiled: QueryCompiledGammaV1,
  candidateKey: string,
  gainAtomIds: readonly string[]
): boolean {
  if (gainAtomIds.length === 0) return false;
  const gainRank = Math.min(...gainAtomIds.map((atomId) =>
    stratumIndex(stratumOf(compiled, atomId))));
  return standingsOf(compiled, candidateKey).some((standing) =>
    standing.coverage === "unknown" &&
    stratumIndex(stratumOf(compiled, standing.atom_id)) < gainRank);
}

function stratumOf(
  compiled: QueryCompiledGammaV1,
  atomId: string
): keyof QueryCompiledGammaTupleV1 {
  const gammaAtom = compiled.atoms.find((row) => row.atom_id === atomId);
  if (gammaAtom === undefined) {
    throw new ShadowContractError("compiled gamma standing references an unknown atom");
  }
  return gammaAtom.stratum;
}
