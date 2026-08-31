import { compareText } from "../../../../../shared/compare-text.js";
import type { ChannelRemainingEffect } from "../../closure/contract.js";
import type {
  AbstractCoordinate,
  AbstractRefinementRequest
} from "./contract.js";

export type ScopedRemainingEffect = Readonly<{
  readonly owner_id: string;
  readonly effect: ChannelRemainingEffect;
}>;

export type AbstractEffectJoin = Readonly<{
  readonly coordinates: readonly AbstractCoordinate[];
  readonly requested_refinements: readonly AbstractRefinementRequest[];
}>;

export function joinChannelRemainingEffects(
  coordinates: readonly AbstractCoordinate[],
  effects: readonly ScopedRemainingEffect[]
): AbstractEffectJoin {
  const joined = new Map(coordinates.map((coordinate) =>
    [coordinate.coordinate_id, coordinate]));
  const requests: AbstractRefinementRequest[] = [];
  for (const scoped of effects) {
    const matches = [...joined.values()].filter(({ sensitivity_id }) =>
      sensitivity_id === scoped.effect.sensitivity_id);
    if (matches.length !== 1) {
      requests.push(effectRequest(scoped,
        matches.length === 0
          ? "bounded effect lacks an abstract coordinate"
          : "bounded effect has ambiguous abstract coordinates"));
      continue;
    }
    const expanded = joinEffect(matches[0]!, scoped.effect);
    if (expanded === null) {
      requests.push(effectRequest(scoped,
        "abstract coordinate domain does not cover bounded effect"));
      continue;
    }
    joined.set(expanded.coordinate_id, expanded);
  }
  return Object.freeze({
    coordinates: Object.freeze([...joined.values()].sort((left, right) =>
      compareText(left.coordinate_id, right.coordinate_id))),
    requested_refinements: Object.freeze(requests.sort((left, right) =>
      compareText(left.sensitivity_id, right.sensitivity_id) ||
      compareText(left.owner_id, right.owner_id) ||
      compareText(left.coordinate_id, right.coordinate_id)))
  });
}

function joinEffect(
  coordinate: AbstractCoordinate,
  effect: ChannelRemainingEffect
): AbstractCoordinate | null {
  switch (effect.effect) {
    case "proposition_bound":
      return coordinate.kind === "numeric_interval" &&
        coordinate.role === "proposition_bound"
        ? expandInterval(coordinate, effect.lower, effect.upper)
        : null;
    case "extremum_interval":
      return coordinate.kind === "numeric_interval" && coordinate.role === "extremum"
        ? expandInterval(coordinate, effect.lower, effect.upper)
        : null;
    case "answer_position":
      return coordinate.kind === "numeric_interval" &&
        coordinate.role === "answer_position"
        ? expandInterval(coordinate, effect.minimum_position, effect.maximum_position)
        : null;
    case "feasibility_change":
      return coordinate.kind === "semantic_feasibility"
        ? Object.freeze({ ...coordinate,
            possible_states: unionText(coordinate.possible_states,
              effect.possible_states) })
        : null;
    case "answer_binding":
      return coordinate.kind === "binding"
        ? Object.freeze({ ...coordinate,
            possible_bindings: unionText(coordinate.possible_bindings,
              effect.possible_bindings) })
        : null;
    case "correlation_group":
      return coordinate.kind === "correlation"
        ? Object.freeze({ ...coordinate,
            possible_relations: unionText(coordinate.possible_relations,
              effect.possible_relations) })
        : null;
    case "tie_winner_membership":
      return coordinate.kind === "identity_tie"
        ? Object.freeze({ ...coordinate,
            possible_winner_digests: unionText(
              coordinate.possible_winner_digests,
              effect.possible_winner_digests) })
        : null;
  }
}

function expandInterval(
  coordinate: Extract<AbstractCoordinate, { kind: "numeric_interval" }>,
  lower: number,
  upper: number
): AbstractCoordinate {
  const expanded = lower < coordinate.lower || upper > coordinate.upper;
  return Object.freeze({
    ...coordinate,
    lower: Math.min(coordinate.lower, lower),
    upper: Math.max(coordinate.upper, upper),
    overlaps_decision_boundary:
      coordinate.overlaps_decision_boundary || expanded
  });
}

function unionText<T extends string>(
  left: readonly T[],
  right: readonly T[]
): readonly T[] {
  return Object.freeze([...new Set([...left, ...right])].sort(compareText));
}

function effectRequest(
  scoped: ScopedRemainingEffect,
  reason: string
): AbstractRefinementRequest {
  return Object.freeze({
    coordinate_id: `effect:${scoped.effect.effect_id}`,
    sensitivity_id: scoped.effect.sensitivity_id,
    owner_id: scoped.owner_id,
    domain_kind: "channel_closure",
    reason
  });
}
