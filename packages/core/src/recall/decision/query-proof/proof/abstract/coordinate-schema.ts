import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from
  "../../../../field/field-identity.js";
import { freezeFiniteValue } from "../oracle/contract.js";
import type { AbstractCoordinate } from "./contract.js";

export function normalizeAbstractCoordinates(
  coordinates: readonly AbstractCoordinate[]
): readonly AbstractCoordinate[] {
  const normalized = coordinates.map(normalizeCoordinate)
    .sort((left, right) => compareText(left.coordinate_id, right.coordinate_id));
  if (new Set(normalized.map(({ coordinate_id }) => coordinate_id)).size !==
      normalized.length) throw new Error("abstract coordinate ids must be unique");
  return Object.freeze(normalized);
}

function normalizeCoordinate(coordinate: AbstractCoordinate): AbstractCoordinate {
  assertIdentity(coordinate.coordinate_id, "abstract coordinate id");
  assertIdentity(coordinate.sensitivity_id, "abstract sensitivity id");
  assertIdentity(coordinate.owner_id, "abstract coordinate owner");
  switch (coordinate.kind) {
    case "membership":
      assertCoordinateKeys(coordinate, ["possible_states"]);
      assertEnumValues(coordinate.possible_states, MEMBERSHIP_STATES,
        "abstract membership state");
      return Object.freeze({ ...coordinate,
        possible_states: freezeStringSet(coordinate.possible_states) });
    case "semantic_feasibility":
      assertCoordinateKeys(coordinate, ["possible_states"]);
      assertEnumValues(coordinate.possible_states, FEASIBILITY_STATES,
        "abstract feasibility state");
      return Object.freeze({ ...coordinate,
        possible_states: freezeStringSet(coordinate.possible_states) });
    case "numeric_interval":
      assertCoordinateKeys(coordinate, [
        "role", "lower", "upper", "overlaps_decision_boundary"
      ]);
      if (!NUMERIC_ROLES.has(coordinate.role) ||
          typeof coordinate.overlaps_decision_boundary !== "boolean") {
        throw new Error("abstract numeric interval metadata is invalid");
      }
      assertInterval(coordinate.lower, coordinate.upper, "abstract numeric interval");
      return Object.freeze({ ...coordinate });
    case "finite_values": {
      assertCoordinateKeys(coordinate, ["possible_values"]);
      const values = coordinate.possible_values.map(freezeFiniteValue)
        .sort((left, right) => compareText(
          digestRecallFieldIdentity(left), digestRecallFieldIdentity(right)));
      if (values.length === 0) throw new Error("abstract finite values cannot be empty");
      return Object.freeze({ ...coordinate, possible_values: Object.freeze(values) });
    }
    case "binding":
      assertCoordinateKeys(coordinate, ["possible_bindings"]);
      return Object.freeze({ ...coordinate,
        possible_bindings: freezeStringSet(coordinate.possible_bindings) });
    case "temporal_interval":
      assertCoordinateKeys(coordinate, ["minimum_epoch_ms", "maximum_epoch_ms"]);
      assertInterval(coordinate.minimum_epoch_ms, coordinate.maximum_epoch_ms,
        "abstract temporal interval");
      return Object.freeze({ ...coordinate });
    case "four_valued_proposition":
      assertCoordinateKeys(coordinate, ["possible_values"]);
      assertEnumValues(coordinate.possible_values, PROPOSITION_VALUES,
        "abstract proposition value");
      return Object.freeze({ ...coordinate,
        possible_values: freezeStringSet(coordinate.possible_values) });
    case "correlation":
      assertCoordinateKeys(coordinate, ["possible_relations"]);
      assertEnumValues(coordinate.possible_relations, CORRELATION_RELATIONS,
        "abstract correlation relation");
      return Object.freeze({ ...coordinate,
        possible_relations: freezeStringSet(coordinate.possible_relations) });
    case "identity_tie":
      assertCoordinateKeys(coordinate, ["universe", "possible_winner_digests"]);
      if (!IDENTITY_UNIVERSES.has(coordinate.universe)) {
        throw new Error("abstract identity universe is invalid");
      }
      coordinate.possible_winner_digests.forEach((value) =>
        assertDigest(value, "abstract tie winner"));
      return Object.freeze({ ...coordinate,
        possible_winner_digests: Object.freeze([
          ...new Set(coordinate.possible_winner_digests)
        ].sort(compareText)) });
    default:
      throw new Error("abstract coordinate domain is unsupported");
  }
}

function freezeStringSet<T extends string>(values: readonly T[]): readonly T[] {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error("abstract finite domain must be nonempty and unique");
  }
  return Object.freeze([...values].sort(compareText));
}

function assertInterval(lower: number, upper: number, field: string): void {
  if (![lower, upper].every(Number.isFinite) || upper < lower) {
    throw new Error(`${field} is invalid`);
  }
}

function assertCoordinateKeys(
  coordinate: AbstractCoordinate,
  domainKeys: readonly string[]
): void {
  const expected = ["coordinate_id", "sensitivity_id", "owner_id", "kind",
    ...domainKeys].sort(compareText);
  const keys = Object.keys(coordinate).sort(compareText);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("abstract coordinate has unknown or missing fields");
  }
}

function assertEnumValues(
  values: readonly string[],
  allowed: ReadonlySet<string>,
  field: string
): void {
  if (values.some((value) => !allowed.has(value))) throw new Error(`${field} is invalid`);
}

function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

function assertDigest(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
}

const MEMBERSHIP_STATES: ReadonlySet<string> = new Set(["absent", "present"]);
const FEASIBILITY_STATES: ReadonlySet<string> = new Set([
  "feasible", "infeasible", "unresolved"
]);
const NUMERIC_ROLES: ReadonlySet<string> = new Set([
  "proposition_bound", "extremum", "answer_position"
]);
const PROPOSITION_VALUES: ReadonlySet<string> = new Set([
  "supported_only", "refuted_only", "both", "unknown"
]);
const CORRELATION_RELATIONS: ReadonlySet<string> = new Set([
  "same_group", "different_group", "unknown"
]);
const IDENTITY_UNIVERSES: ReadonlySet<string> = new Set(["finite", "open"]);
