import type { AbstractCoordinate } from "./contract.js";

export function isConflictCoordinate(coordinate: AbstractCoordinate): boolean {
  return coordinate.kind === "four_valued_proposition" &&
    coordinate.possible_values.includes("both");
}

export function isStrictlyOpenCoordinate(coordinate: AbstractCoordinate): boolean {
  return (
    (coordinate.kind === "identity_tie" && coordinate.universe === "open") ||
    (coordinate.kind === "correlation" &&
      coordinate.possible_relations.includes("unknown")) ||
    (coordinate.kind === "semantic_feasibility" &&
      coordinate.possible_states.includes("unresolved")) ||
    (coordinate.kind === "numeric_interval" && coordinate.role === "extremum" &&
      coordinate.overlaps_decision_boundary) ||
    (coordinate.kind === "four_valued_proposition" &&
      coordinate.possible_values.includes("unknown"))
  );
}

export function isDecisionOpenCoordinate(coordinate: AbstractCoordinate): boolean {
  switch (coordinate.kind) {
    case "membership":
    case "semantic_feasibility":
      return coordinate.possible_states.length > 1;
    case "numeric_interval":
      return coordinate.lower < coordinate.upper;
    case "finite_values":
    case "four_valued_proposition":
      return coordinate.possible_values.length > 1;
    case "binding":
      return coordinate.possible_bindings.length > 1;
    case "temporal_interval":
      return coordinate.minimum_epoch_ms < coordinate.maximum_epoch_ms;
    case "correlation":
      return coordinate.possible_relations.length > 1;
    case "identity_tie":
      return coordinate.universe === "open" ||
        coordinate.possible_winner_digests.length > 1;
  }
}

export function strictOpenReason(coordinate: AbstractCoordinate): string {
  switch (coordinate.kind) {
    case "identity_tie": return "open identity tail";
    case "correlation": return "unknown correlation";
    case "semantic_feasibility": return "unresolved semantic feasibility";
    case "numeric_interval": return "overlapping extremum interval";
    default: return "unknown proposition state";
  }
}
