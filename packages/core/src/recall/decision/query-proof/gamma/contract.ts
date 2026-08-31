import { compareText } from "../../../../shared/compare-text.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../../../field/field-identity.js";
import { ShadowContractError } from "../../contract-primitives.js";
import {
  COMPILED_GAMMA_KEYS,
  type QueryCompiledWalkGamma
} from "../../prefix-capture/receipts.js";

export const QUERY_PROOF_GAMMA_OPERATOR_ID = "query_proof_gamma_v1" as const;

export const QUERY_GAMMA_STRATA = COMPILED_GAMMA_KEYS;

export type QueryGammaStratumV1 = (typeof QUERY_GAMMA_STRATA)[number];

export type QueryGammaCompileStatusV1 = "compiled" | "unsupported";

export type SemanticFeasibilityV1 = "feasible" | "infeasible" | "unresolved";

export type QueryGammaAtomKindV1 =
  | "scalar_binding"
  | "distinct_binding"
  | "sequence_slot"
  | "extremum_binding"
  | "required_proposition"
  | "certified_independent_support";

export type QueryGammaCoverageV1 = "covers" | "does_not_cover" | "unknown";

export type QueryGammaIndependenceV1 =
  | "certified_independent"
  | "unknown"
  | "correlated"
  | "not_applicable";

export type QueryGammaAtomV1 = Readonly<{
  readonly atom_id: string;
  readonly stratum: QueryGammaStratumV1;
  readonly kind: QueryGammaAtomKindV1;
  readonly target: string;
}>;

export type QueryGammaStandingV1 = Readonly<{
  readonly candidate_key: string;
  readonly atom_id: string;
  readonly coverage: QueryGammaCoverageV1;
  readonly independence: QueryGammaIndependenceV1;
}>;

export type QueryCompiledGammaTupleV1 = QueryCompiledWalkGamma;

export type ResourceFeasibilityPolicyV1 = Readonly<{
  readonly schema_version: 1;
  readonly reject_duplicate_object: true;
  readonly token_budget: number | null;
  readonly per_dimension_limits: Readonly<Record<string, number>> | null;
}>;

export type QueryGammaSealObligationV1 = Readonly<{
  readonly kind: "all_observable";
  readonly target: string;
}>;

export type QueryGammaBindingEvidenceV1 = Readonly<{
  readonly variable: string;
  readonly semantic_identity: string;
  readonly distinctness: "proved_distinct" | "may_equal" | "unknown";
}>;

export type QueryGammaPropositionEvidenceV1 = Readonly<{
  readonly proposition_id: string;
  readonly support: "supports" | "absent" | "unknown" | "refutes";
  readonly independence: QueryGammaIndependenceV1;
}>;

export type QueryGammaSequenceSlotV1 = Readonly<{
  readonly position: number;
  readonly binding: string;
}>;

export type QueryGammaCandidateEvidenceV1 = Readonly<{
  readonly candidate_key: string;
  readonly object_key: string;
  readonly token_cost: number;
  readonly dimension: string;
  readonly bindings_status: "observed" | "unknown";
  readonly bindings: readonly QueryGammaBindingEvidenceV1[];
  readonly propositions_status: "observed" | "unknown";
  readonly propositions: readonly QueryGammaPropositionEvidenceV1[];
  readonly sequence_slots: readonly QueryGammaSequenceSlotV1[];
  readonly extremal_bindings: readonly string[];
}>;

export type QueryGammaCandidateFeasibilityV1 = Readonly<{
  readonly candidate_key: string;
  readonly semantic: SemanticFeasibilityV1;
}>;

export type QueryCompiledGammaV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof QUERY_PROOF_GAMMA_OPERATOR_ID;
  readonly compile_status: QueryGammaCompileStatusV1;
  readonly unsupported_reason: string | null;
  readonly query_digest: RecallFieldDigest;
  readonly compilation_digest: RecallFieldDigest;
  readonly independent_support_obligation: boolean;
  readonly resource_policy: ResourceFeasibilityPolicyV1;
  readonly seal_obligations: readonly QueryGammaSealObligationV1[];
  readonly atoms: readonly QueryGammaAtomV1[];
  readonly standings: readonly QueryGammaStandingV1[];
  readonly semantic_feasibility: readonly QueryGammaCandidateFeasibilityV1[];
  readonly gamma_digest: RecallFieldDigest;
}>;

export const DEFAULT_RESOURCE_FEASIBILITY_POLICY: ResourceFeasibilityPolicyV1 =
  Object.freeze({
    schema_version: 1 as const,
    reject_duplicate_object: true as const,
    token_budget: null,
    per_dimension_limits: null
  });

export const FORBIDDEN_GAMMA_EVIDENCE_KEYS = Object.freeze([
  "facility",
  "Values_v",
  "content_id",
  "cid",
  "source_id",
  "fused_score",
  "frontier_index",
  "FrontierPriority",
  "frontier_priority",
  "prior",
  "unscaled_remainder",
  "evidence_novelty_redundancy",
  "match_strength",
  "independent_evidence",
  "weight",
  "weights",
  "gold",
  "benchmark",
  "facility_keys",
  "value_pairs"
]);

const INDEPENDENT_SUPPORT_TOKENS: ReadonlySet<string> = new Set([
  "independent_support",
  "certified_independent_support"
]);

export function isIndependentSupportToken(value: string): boolean {
  return INDEPENDENT_SUPPORT_TOKENS.has(value);
}

export function emptyQueryGammaTuple(): QueryCompiledGammaTupleV1 {
  return Object.freeze({
    answer_binding_position: 0,
    required_proposition_support: 0,
    certified_independent_support: 0
  });
}

export function compareQueryGammaTuple(
  left: QueryCompiledGammaTupleV1,
  right: QueryCompiledGammaTupleV1
): number {
  for (const stratum of QUERY_GAMMA_STRATA) {
    if (left[stratum] !== right[stratum]) {
      return left[stratum] > right[stratum] ? 1 : -1;
    }
  }
  return 0;
}

export function rejectForbiddenGammaKeys(
  value: object,
  label: string
): void {
  const keys = Object.keys(value);
  const forbidden = keys.filter((key) => FORBIDDEN_GAMMA_EVIDENCE_KEYS.includes(key));
  if (forbidden.length > 0) {
    throw new ShadowContractError(
      `${label} must not inject ${forbidden.sort(compareText).join(",")}`
    );
  }
}

export function assertExactGammaKeys(
  value: object,
  expected: readonly string[],
  label: string
): void {
  rejectForbiddenGammaKeys(value, label);
  const keys = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new ShadowContractError(`${label} has unknown or missing fields`);
  }
}

export function sortGammaAtoms(
  atoms: readonly QueryGammaAtomV1[]
): readonly QueryGammaAtomV1[] {
  return Object.freeze([...atoms].sort((left, right) =>
    stratumIndex(left.stratum) - stratumIndex(right.stratum) ||
    compareText(left.atom_id, right.atom_id)));
}

export function stratumIndex(stratum: QueryGammaStratumV1): number {
  return QUERY_GAMMA_STRATA.indexOf(stratum);
}

export function digestQueryGammaBody(
  body: Omit<QueryCompiledGammaV1, "gamma_digest" | "standings" | "semantic_feasibility">
): RecallFieldDigest {
  return digestRecallFieldIdentity(body);
}


