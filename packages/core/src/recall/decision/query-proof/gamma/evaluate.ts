import { compareText } from "../../../../shared/compare-text.js";
import { ShadowContractError } from "../../contract-primitives.js";
import {
  type QueryCompiledGammaTupleV1,
  type QueryCompiledGammaV1,
  type QueryGammaAtomV1,
  type QueryGammaCandidateEvidenceV1,
  type QueryGammaCoverageV1,
  type QueryGammaIndependenceV1,
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
  const refuted = atoms.some((gammaAtom) => {
    const match = candidate.propositions.find((proposition) =>
      proposition.proposition_id === gammaAtom.target);
    return match?.support === "refutes";
  });
  if (refuted) return "infeasible";
  if (standings.some((row) => row.coverage === "unknown")) return "unresolved";
  return "feasible";
}

export function evaluateQueryGammaTuple(
  compiled: QueryCompiledGammaV1,
  selected: QueryGammaSelectedSetV1,
  candidateKey: string
): QueryCompiledGammaTupleV1 {
  if (compiled.compile_status !== "compiled") {
    throw new ShadowContractError("unsupported Gamma cannot be scored as a zero tuple");
  }
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
  coreKeys: readonly string[]
): QueryGammaAdmissionV1 {
  const novel = novelCoveredAtoms(compiled, selected, candidateKey);
  const admitted = novel.filter((atomId) =>
    coreKeys.every((coreKey) => provedNotToCover(compiled, coreKey, atomId)));
  return Object.freeze({
    admitted: admitted.length > 0,
    compiled_atom_ids: Object.freeze([...admitted].sort(compareText))
  });
}

export function acceptQueryGammaCandidate(
  selected: QueryGammaSelectedSetV1,
  compiled: QueryCompiledGammaV1,
  candidateKey: string,
  objectKey: string,
  tokenCost: number,
  dimension: string
): QueryGammaSelectedSetV1 {
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

export function certifiedSemanticSet(
  compiled: QueryCompiledGammaV1
): ReadonlySet<string> {
  return new Set(compiled.semantic_feasibility
    .filter((row) => row.semantic === "feasible")
    .map((row) => row.candidate_key));
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
    return bindingCoverage(candidate, gammaAtom.target);
  }
  if (gammaAtom.kind === "sequence_slot") {
    const [position, binding] = splitSlot(gammaAtom.target);
    if (candidate.bindings_status === "unknown") return "unknown";
    return candidate.sequence_slots.some((slot) =>
      slot.position === position && slot.binding === binding)
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

function propositionCoverage(
  gammaAtom: QueryGammaAtomV1,
  candidate: QueryGammaCandidateEvidenceV1
): QueryGammaCoverageV1 {
  if (candidate.propositions_status === "unknown") return "unknown";
  const match = candidate.propositions.find((proposition) =>
    proposition.proposition_id === gammaAtom.target);
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
  identity: string
): QueryGammaCoverageV1 {
  if (candidate.bindings_status === "unknown") return "unknown";
  const hits = candidate.bindings.filter((binding) => binding.semantic_identity === identity);
  if (hits.some((binding) => binding.distinctness === "unknown")) return "unknown";
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
    proposition.proposition_id === gammaAtom.target);
  return match?.independence ?? "unknown";
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

function provedNotToCover(
  compiled: QueryCompiledGammaV1,
  candidateKey: string,
  atomId: string
): boolean {
  const standing = standingsOf(compiled, candidateKey)
    .find((row) => row.atom_id === atomId);
  return standing?.coverage === "does_not_cover";
}

function standingsOf(
  compiled: QueryCompiledGammaV1,
  candidateKey: string
): readonly QueryGammaStandingV1[] {
  return compiled.standings.filter((row) => row.candidate_key === candidateKey);
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

function splitSlot(target: string): readonly [number, string] {
  const split = target.indexOf(":");
  return [Number(target.slice(0, split)), target.slice(split + 1)];
}
