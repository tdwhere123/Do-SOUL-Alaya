import type {
  CoverageSelectableCandidate,
  CoverageSelectionObjective
} from "../delivery/coverage-selection.js";
import {
  buildCoverageProjectionFormKey,
  type CandidateCoverageAtom,
  type CandidateCoverageReceipt
} from "../delivery/fine-assessment-selection/coverage-atoms.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "./field-identity.js";
import { compareText } from "../../shared/compare-text.js";
import {
  verifyAttributedQueryFacilityDemand,
  type AttributedQueryFacilityDemandReceipt
} from "./query-facility-demand.js";
import { REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID } from
  "./facility/relation-inflection-alignment.js";
import { STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID } from
  "./fact-frame-semantic-factors.js";

export const ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID =
  "attributed_facility_location_v1";

export type FacilityDemandKind =
  | "entity"
  | "relation"
  | "time"
  | "logical_object"
  | "independent_evidence";

export type FacilityDemandAtom = Readonly<{
  readonly demand_atom_id: string;
  readonly kind: FacilityDemandKind;
  readonly weight: number;
}>;

export type AttributedFacilityCoverageMatch = Readonly<{
  readonly demand_atom_id: string;
  readonly coverage_atom_id: string;
  readonly independence_key: string;
  readonly projection_form_keys: readonly string[];
  readonly alignment_operator_id:
    | "identity_v1"
    | "exact_token_sequence_v1"
    | "porter_regular_plural_v1"
    | typeof REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID
    | typeof STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID;
  readonly match_strength: number;
}>;

export type AttributedFacilityCoverageState = Readonly<{
  readonly best_by_demand_atom: Map<string, number>;
}>;

export function createAttributedFacilityCoverageObjective<
  T extends CoverageSelectableCandidate = CoverageSelectableCandidate
>(config: Readonly<{
  readonly base_relevance_weight: number;
  readonly demand: Readonly<AttributedQueryFacilityDemandReceipt>;
  readonly matches_by_candidate_key: ReadonlyMap<
    string,
    readonly Readonly<AttributedFacilityCoverageMatch>[]
  >;
}>): CoverageSelectionObjective<T, AttributedFacilityCoverageState> {
  const normalized = normalizeConfig(config);
  return Object.freeze({
    operator_id: ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID,
    mathematical_class: "monotone_submodular" as const,
    configuration_digest: normalized.configurationDigest,
    createState: () => ({ best_by_demand_atom: new Map() }),
    cloneState: (state) => ({
      best_by_demand_atom: new Map(state.best_by_demand_atom)
    }),
    marginalGain: ({ candidate, relevance, coverage, state }) => {
      const matches = resolveCandidateMatches(
        candidate.fusion.candidate_key,
        coverage,
        normalized
      );
      return normalized.baseRelevanceWeight * assertUnit(relevance, "relevance") +
        facilityMarginalGain(matches, relevance, state, normalized.demandById);
    },
    accept: ({ candidate, relevance, coverage, state }) => {
      const matches = resolveCandidateMatches(
        candidate.fusion.candidate_key,
        coverage,
        normalized
      );
      for (const [demandAtomId, strength] of matches) {
        const value = strength * assertUnit(relevance, "relevance");
        state.best_by_demand_atom.set(
          demandAtomId,
          Math.max(state.best_by_demand_atom.get(demandAtomId) ?? 0, value)
        );
      }
    },
    unseenMarginalGainUpperBound: ({ relevanceUpperBound, state }) =>
      facilityUnseenMarginalGainUpperBound(
        assertUnit(relevanceUpperBound, "unseen relevance upper bound"),
        state,
        normalized
      ),
    compareCandidatesOnEqualGain: (left, right) =>
      compareText(left.fusion.candidate_key, right.fusion.candidate_key)
  });
}

type NormalizedFacilityConfig = Readonly<{
  readonly baseRelevanceWeight: number;
  readonly configurationDigest: RecallFieldDigest;
  readonly demandById: ReadonlyMap<string, Readonly<FacilityDemandAtom>>;
  readonly matchesByCandidateKey: ReadonlyMap<
    string,
    readonly Readonly<AttributedFacilityCoverageMatch>[]
  >;
}>;

function normalizeConfig(config: Readonly<{
  readonly base_relevance_weight: number;
  readonly demand: Readonly<AttributedQueryFacilityDemandReceipt>;
  readonly matches_by_candidate_key: ReadonlyMap<
    string,
    readonly Readonly<AttributedFacilityCoverageMatch>[]
  >;
}>): NormalizedFacilityConfig {
  const baseRelevanceWeight = assertNonNegative(
    config.base_relevance_weight,
    "base relevance weight"
  );
  verifyAttributedQueryFacilityDemand(config.demand);
  const demandById = new Map<string, Readonly<FacilityDemandAtom>>();
  for (const demand of config.demand.demand_atoms) {
    assertIdentity(demand.demand_atom_id, "demand atom id");
    if (demandById.has(demand.demand_atom_id)) throw new Error("demand atom ids must be unique");
    if (!DEMAND_KINDS.has(demand.kind)) throw new Error("facility demand kind is invalid");
    demandById.set(demand.demand_atom_id, Object.freeze({
      ...demand,
      weight: assertNonNegative(demand.weight, "demand weight")
    }));
  }
  const matchesByCandidateKey = normalizeMatches(config.matches_by_candidate_key);
  return Object.freeze({
    baseRelevanceWeight,
    configurationDigest: digestRecallFieldIdentity({
      base_relevance_weight: baseRelevanceWeight,
      demand_digest: config.demand.demand_digest,
      matches_by_candidate_key: [...matchesByCandidateKey]
    }),
    demandById,
    matchesByCandidateKey
  });
}

function normalizeMatches(
  input: ReadonlyMap<string, readonly Readonly<AttributedFacilityCoverageMatch>[]>
): ReadonlyMap<string, readonly Readonly<AttributedFacilityCoverageMatch>[]> {
  return new Map([...input]
    .sort(([left], [right]) => compareText(left, right))
    .map(([candidateKey, matches]) => {
    assertIdentity(candidateKey, "facility match candidate key");
    return [candidateKey, Object.freeze(matches.map((match) => {
      assertIdentity(match.demand_atom_id, "facility match demand atom id");
      assertIdentity(match.coverage_atom_id, "facility match coverage atom id");
      assertIdentity(match.independence_key, "facility match independence key");
      if (!FACILITY_ALIGNMENT_OPERATORS.has(match.alignment_operator_id)) {
        throw new Error("facility match alignment operator is invalid");
      }
      assertUnit(match.match_strength, "facility match strength");
      const forms = match.projection_form_keys.map((form) => {
        assertIdentity(form, "facility match projection form key");
        return form;
      }).sort(compareText);
      if (new Set(forms).size !== forms.length) {
        throw new Error("facility match projection form keys must be unique");
      }
      return Object.freeze({ ...match, projection_form_keys: Object.freeze(forms) });
    }).sort(compareFacilityMatches))] as const;
  }));
}

function compareFacilityMatches(
  left: Readonly<AttributedFacilityCoverageMatch>,
  right: Readonly<AttributedFacilityCoverageMatch>
): number {
  return compareText(
    JSON.stringify([
      left.demand_atom_id,
      left.coverage_atom_id,
      left.independence_key,
      left.projection_form_keys,
      left.alignment_operator_id,
      left.match_strength
    ]),
    JSON.stringify([
      right.demand_atom_id,
      right.coverage_atom_id,
      right.independence_key,
      right.projection_form_keys,
      right.alignment_operator_id,
      right.match_strength
    ])
  );
}

function facilityMarginalGain(
  matches: ReadonlyMap<string, number>,
  relevance: number,
  state: AttributedFacilityCoverageState,
  demandById: ReadonlyMap<string, Readonly<FacilityDemandAtom>>
): number {
  let gain = 0;
  for (const [demandAtomId, strength] of matches) {
    const covered = relevance * strength;
    const previous = state.best_by_demand_atom.get(demandAtomId) ?? 0;
    gain += demandById.get(demandAtomId)!.weight * Math.max(0, covered - previous);
  }
  return gain;
}

function facilityUnseenMarginalGainUpperBound(
  relevanceUpperBound: number,
  state: AttributedFacilityCoverageState,
  config: NormalizedFacilityConfig
): number {
  let gain = config.baseRelevanceWeight * relevanceUpperBound;
  for (const demand of config.demandById.values()) {
    const previous = state.best_by_demand_atom.get(demand.demand_atom_id) ?? 0;
    gain += demand.weight * Math.max(0, relevanceUpperBound - previous);
  }
  return gain;
}

function resolveCandidateMatches(
  candidateKey: string,
  coverage: Readonly<CandidateCoverageReceipt>,
  config: NormalizedFacilityConfig
): ReadonlyMap<string, number> {
  if (coverage.candidate_key !== candidateKey) {
    throw new Error("facility candidate and coverage receipt identity mismatch");
  }
  const atoms = new Map(coverage.atoms.map((atom) => [atom.atom_id, atom]));
  const byDemand = new Map<string, number>();
  for (const match of config.matchesByCandidateKey.get(coverage.candidate_key) ?? []) {
    const demand = config.demandById.get(match.demand_atom_id);
    const atom = atoms.get(match.coverage_atom_id);
    if (demand === undefined || atom === undefined) {
      throw new Error("facility match must cite a known demand and coverage atom");
    }
    validateMatch(match, demand, atom);
    byDemand.set(
      match.demand_atom_id,
      Math.max(byDemand.get(match.demand_atom_id) ?? 0, match.match_strength)
    );
  }
  return byDemand;
}

function validateMatch(
  match: Readonly<AttributedFacilityCoverageMatch>,
  demand: Readonly<FacilityDemandAtom>,
  atom: Readonly<CandidateCoverageAtom>
): void {
  const strength = assertUnit(match.match_strength, "facility match strength");
  if (match.independence_key !== atom.independence_key || strength > atom.strength) {
    throw new Error("facility match must preserve atom attribution and strength");
  }
  assertCompatibleKind(demand.kind, atom.kind);
  const availableForms = new Set((atom.projection?.matched_fact_key_forms ?? [])
    .map(buildCoverageProjectionFormKey));
  const citedForms = new Set(match.projection_form_keys);
  const fieldDemand = demand.kind === "entity" ||
    demand.kind === "relation" || demand.kind === "time";
  if (citedForms.size !== match.projection_form_keys.length ||
      [...citedForms].some((form) => !availableForms.has(form)) ||
      (atom.kind !== "fact_projection" && citedForms.size > 0) ||
      (fieldDemand && citedForms.size === 0)) {
    throw new Error("facility match projection form is not present in the coverage receipt");
  }
  const porterAlignment = match.alignment_operator_id === "porter_regular_plural_v1" ||
    match.alignment_operator_id === REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID;
  if (fieldDemand === (match.alignment_operator_id === "identity_v1") ||
      (porterAlignment && !atom.matched_fts_lanes?.includes("porter")) ||
      (match.alignment_operator_id === REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID &&
        demand.kind !== "relation") ||
      (match.alignment_operator_id === STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID &&
        demand.kind !== "relation")) {
    throw new Error("facility match alignment operator lacks attributed evidence");
  }
}

const FACILITY_ALIGNMENT_OPERATORS = new Set([
  "identity_v1",
  "exact_token_sequence_v1",
  "porter_regular_plural_v1",
  REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID,
  STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID
]);

function assertCompatibleKind(
  demandKind: FacilityDemandKind,
  atomKind: CandidateCoverageAtom["kind"]
): void {
  const valid = demandKind === "logical_object"
    ? atomKind === "logical_object"
    : demandKind === "independent_evidence"
      ? atomKind === "independent_evidence"
      : atomKind === "fact_projection";
  if (!valid) throw new Error("facility demand kind is incompatible with coverage atom kind");
}

function assertIdentity(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

function assertUnit(value: number, field: string): number {
  const validated = assertNonNegative(value, field);
  if (validated > 1) throw new Error(`${field} must be at most one`);
  return validated;
}

function assertNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be finite and non-negative`);
  }
  return value;
}


const DEMAND_KINDS: ReadonlySet<string> = new Set([
  "entity",
  "relation",
  "time",
  "logical_object",
  "independent_evidence"
]);
