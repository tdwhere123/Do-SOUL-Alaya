import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "./field-identity.js";

export const SAFE_CANDIDATE_DOMINANCE_OPERATOR_ID =
  "safe_candidate_dominance_v1";

export type SafeDominanceCandidate = Readonly<{
  readonly candidate_key: string;
  readonly feasible: boolean;
  readonly relevance_interval: Readonly<{
    readonly lower: number;
    readonly upper: number;
  }>;
  readonly coverage_by_demand_atom: ReadonlyMap<string, number>;
  readonly resource_cost_by_id: ReadonlyMap<string, number>;
  readonly governance_risk_by_id: ReadonlyMap<string, number>;
}>;

export type SafeCandidateDominanceAssessment = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof SAFE_CANDIDATE_DOMINANCE_OPERATOR_ID;
  readonly configuration_digest: RecallFieldDigest;
  readonly input_digest: RecallFieldDigest;
  readonly challenger_candidate_key: string;
  readonly challenged_candidate_key: string;
  readonly conditions: Readonly<{
    readonly challenger_feasible: boolean;
    readonly relevance_interval_separated: boolean;
    readonly coverage_dominates: boolean;
    readonly resource_cost_dominates: boolean;
    readonly governance_risk_dominates: boolean;
    readonly deterministic_identity_winner: boolean;
  }>;
  readonly dominated: boolean;
  readonly assessment_digest: RecallFieldDigest;
}>;

export function assessSafeCandidateDominance(params: Readonly<{
  readonly demand_atom_ids: readonly string[];
  readonly resource_ids: readonly string[];
  readonly governance_risk_ids: readonly string[];
  readonly challenger: Readonly<SafeDominanceCandidate>;
  readonly challenged: Readonly<SafeDominanceCandidate>;
}>): SafeCandidateDominanceAssessment {
  const catalog = normalizeCatalogs(params);
  const challenger = normalizeCandidate(params.challenger, catalog);
  const challenged = normalizeCandidate(params.challenged, catalog);
  if (challenger.candidate_key === challenged.candidate_key) {
    throw new Error("safe dominance requires two distinct candidates");
  }
  const comparisons = compareVectors(challenger, challenged);
  const identityWinner = comparisons.strict ||
    compareText(challenger.candidate_key, challenged.candidate_key) < 0;
  const conditions = Object.freeze({
    challenger_feasible: challenger.feasible,
    relevance_interval_separated:
      challenger.relevance_interval.lower >= challenged.relevance_interval.upper,
    coverage_dominates: comparisons.coverage,
    resource_cost_dominates: comparisons.resources,
    governance_risk_dominates: comparisons.governance,
    deterministic_identity_winner: identityWinner
  });
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: SAFE_CANDIDATE_DOMINANCE_OPERATOR_ID,
    configuration_digest: digestRecallFieldIdentity(catalog),
    input_digest: digestRecallFieldIdentity({ challenger, challenged }),
    challenger_candidate_key: challenger.candidate_key,
    challenged_candidate_key: challenged.candidate_key,
    conditions,
    dominated: Object.values(conditions).every(Boolean)
  });
  return Object.freeze({
    ...body,
    assessment_digest: digestRecallFieldIdentity(body)
  });
}

type NormalizedCatalogs = Readonly<{
  readonly demand_atom_ids: readonly string[];
  readonly resource_ids: readonly string[];
  readonly governance_risk_ids: readonly string[];
}>;

type NormalizedCandidate = Readonly<{
  readonly candidate_key: string;
  readonly feasible: boolean;
  readonly relevance_interval: Readonly<{ readonly lower: number; readonly upper: number }>;
  readonly coverage: readonly Readonly<{ readonly id: string; readonly value: number }>[];
  readonly resources: readonly Readonly<{ readonly id: string; readonly value: number }>[];
  readonly governance: readonly Readonly<{ readonly id: string; readonly value: number }>[];
}>;

function normalizeCatalogs(params: Readonly<{
  readonly demand_atom_ids: readonly string[];
  readonly resource_ids: readonly string[];
  readonly governance_risk_ids: readonly string[];
}>): NormalizedCatalogs {
  return Object.freeze({
    demand_atom_ids: normalizeCatalog(params.demand_atom_ids, "demand atom catalog"),
    resource_ids: normalizeCatalog(params.resource_ids, "resource catalog"),
    governance_risk_ids: normalizeCatalog(
      params.governance_risk_ids,
      "governance risk catalog"
    )
  });
}

function normalizeCandidate(
  candidate: Readonly<SafeDominanceCandidate>,
  catalog: NormalizedCatalogs
): NormalizedCandidate {
  assertIdentity(candidate.candidate_key, "dominance candidate key");
  const lower = assertUnit(candidate.relevance_interval.lower, "relevance lower bound");
  const upper = assertUnit(candidate.relevance_interval.upper, "relevance upper bound");
  if (lower > upper) throw new Error("relevance interval lower bound exceeds upper bound");
  return Object.freeze({
    candidate_key: candidate.candidate_key,
    feasible: candidate.feasible,
    relevance_interval: Object.freeze({ lower, upper }),
    coverage: normalizeCoordinates(
      candidate.coverage_by_demand_atom,
      catalog.demand_atom_ids,
      "coverage",
      assertUnit
    ),
    resources: normalizeCoordinates(
      candidate.resource_cost_by_id,
      catalog.resource_ids,
      "resource cost",
      assertNonNegative
    ),
    governance: normalizeCoordinates(
      candidate.governance_risk_by_id,
      catalog.governance_risk_ids,
      "governance risk",
      assertNonNegative
    )
  });
}

function normalizeCoordinates(
  values: ReadonlyMap<string, number>,
  catalog: readonly string[],
  field: string,
  validate: (value: number, field: string) => number
): readonly Readonly<{ readonly id: string; readonly value: number }>[] {
  if (values.size !== catalog.length || catalog.some((id) => !values.has(id))) {
    throw new Error(`${field} coordinates must exactly cover their catalog`);
  }
  return Object.freeze(catalog.map((id) => Object.freeze({
    id,
    value: validate(values.get(id)!, field)
  })));
}

function compareVectors(
  challenger: NormalizedCandidate,
  challenged: NormalizedCandidate
): Readonly<{
  readonly coverage: boolean;
  readonly resources: boolean;
  readonly governance: boolean;
  readonly strict: boolean;
}> {
  const coverage = everyCoordinate(challenger.coverage, challenged.coverage, (a, b) => a >= b);
  const resources = everyCoordinate(challenger.resources, challenged.resources, (a, b) => a <= b);
  const governance = everyCoordinate(challenger.governance, challenged.governance, (a, b) => a <= b);
  const strict = challenger.relevance_interval.lower > challenged.relevance_interval.upper ||
    someCoordinate(challenger.coverage, challenged.coverage, (a, b) => a > b) ||
    someCoordinate(challenger.resources, challenged.resources, (a, b) => a < b) ||
    someCoordinate(challenger.governance, challenged.governance, (a, b) => a < b);
  return Object.freeze({ coverage, resources, governance, strict });
}

function everyCoordinate(
  left: NormalizedCandidate["coverage"],
  right: NormalizedCandidate["coverage"],
  compare: (left: number, right: number) => boolean
): boolean {
  return left.every((value, index) => compare(value.value, right[index]!.value));
}

function someCoordinate(
  left: NormalizedCandidate["coverage"],
  right: NormalizedCandidate["coverage"],
  compare: (left: number, right: number) => boolean
): boolean {
  return left.some((value, index) => compare(value.value, right[index]!.value));
}

function normalizeCatalog(values: readonly string[], field: string): readonly string[] {
  const output = values.map((value) => {
    assertIdentity(value, field);
    return value;
  }).sort(compareText);
  if (new Set(output).size !== output.length) throw new Error(`${field} must be unique`);
  return Object.freeze(output);
}

function assertUnit(value: number, field: string): number {
  const normalized = assertNonNegative(value, field);
  if (normalized > 1) throw new Error(`${field} must be at most one`);
  return normalized;
}

function assertNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be finite and non-negative`);
  }
  return value;
}

function assertIdentity(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
