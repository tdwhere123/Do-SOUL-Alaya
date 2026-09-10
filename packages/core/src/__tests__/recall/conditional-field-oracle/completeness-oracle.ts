import { MILLIGRADE_TOP, productSubjectId } from "@do-soul/alaya-protocol";
import type { FiniteWorld } from "./finite-worlds.js";

export type OracleClaim = "unknown" | "supported" | "refuted";

export type OracleMember = Readonly<{
  readonly id: string;
  readonly grade: number;
}>;

export type OracleCompletion = Readonly<{
  readonly members: readonly OracleMember[];
  readonly claims: Readonly<Record<string, OracleClaim>>;
  readonly order: readonly string[];
}>;

export type SourceModel = Readonly<{
  readonly known?: Readonly<{ readonly id: string; readonly grade: number }>;
  readonly unknown_seed?: boolean;
  readonly required_measurement?: boolean;
  readonly optional_discovery?: boolean;
  readonly incompatible_hypotheses?: boolean;
  readonly comparison?: "gt" | "gte";
  readonly threshold?: number;
  readonly quantized_threshold?: number;
  readonly uses_raw?: boolean;
  readonly partial_source?: boolean;
  readonly unfinished_join?: boolean;
  readonly join_strength?: number;
  readonly later_refutation?: boolean;
  readonly between_grade?: number;
}>;

export type OracleStability = Readonly<{
  readonly membership: boolean;
  readonly claim: boolean;
  readonly order: boolean;
}>;

export function orderOf(members: readonly OracleMember[]): readonly string[] {
  return [...members]
    .sort((left, right) => right.grade - left.grade || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((member) => member.id);
}

export function enumerateCompletions(model: SourceModel): readonly OracleCompletion[] {
  const known: OracleMember[] = model.known === undefined ? [] : [model.known];
  const completions: OracleCompletion[] = [completionOf(model, known)];
  if (model.unknown_seed === true) {
    completions.push(completionOf(model, []));
    completions.push(completionOf(model, [{ id: "x", grade: MILLIGRADE_TOP }]));
  }
  if (model.required_measurement === true) {
    completions.push(completionOf(model, []));
  }
  if (model.optional_discovery === true && model.known !== undefined) {
    completions.push(completionOf(model, [
      { id: model.known.id, grade: Math.min(MILLIGRADE_TOP, model.known.grade + 100) }
    ]));
  }
  if (model.incompatible_hypotheses === true) {
    return [
      completionOf(model, [{ id: "h0", grade: 500 }]),
      completionOf(model, [{ id: "h1", grade: 900 }])
    ];
  }
  if (model.between_grade !== undefined) {
    completions.push(completionOf(model, [{
      id: model.known?.id ?? "r",
      grade: model.between_grade
    }]));
  }
  if (model.partial_source === true) {
    completions.push(completionOf(model, [...known, { id: "src", grade: MILLIGRADE_TOP }]));
  }
  if (model.unfinished_join === true) {
    completions.push(completionOf(model, [{ id: "j", grade: model.join_strength ?? 600 }]));
  }
  return completions;
}

export function enumerateWorldCompletions(world: SourceModel | FiniteWorld): readonly OracleCompletion[] {
  return enumerateCompletions(sourceModelOf(world));
}

export function sourceModelOf(world: SourceModel | FiniteWorld): SourceModel {
  if (isFiniteWorld(world)) {
    const seed = world.seeds[0];
    return {
      known: seed === undefined ? undefined : {
        id: productSubjectId(seed.state),
        grade: seed.milligrades
      }
    };
  }
  return world;
}

export function oracleLegalMembers(completion: OracleCompletion): ReadonlySet<string> {
  return new Set(completion.members.map((member) => member.id));
}

export function oracleGuaranteedMembers(completions: readonly OracleCompletion[]): ReadonlySet<string> {
  if (completions.length === 0) return new Set();
  const guaranteed = new Set(oracleLegalMembers(completions[0]!));
  for (const completion of completions.slice(1)) {
    const members = oracleLegalMembers(completion);
    for (const id of [...guaranteed]) {
      if (!members.has(id)) guaranteed.delete(id);
    }
  }
  return guaranteed;
}

export function oraclePossibleMembers(completions: readonly OracleCompletion[]): ReadonlySet<string> {
  const possible = new Set<string>();
  for (const completion of completions) {
    for (const id of oracleLegalMembers(completion)) possible.add(id);
  }
  return possible;
}

export function oracleStability(
  lower: Readonly<{
    readonly members: readonly string[];
    readonly claims: Readonly<Record<string, OracleClaim>>;
    readonly order: readonly string[];
  }>,
  completions: readonly OracleCompletion[]
): OracleStability {
  if (completions.length === 0) {
    return { membership: false, claim: false, order: false };
  }
  const lowerMembers = new Set(lower.members);
  return {
    membership: completions.every((completion) =>
      sameSet(oracleLegalMembers(completion), lowerMembers)),
    claim: completions.every((completion) => sameClaims(completion.claims, lower.claims)),
    order: completions.every((completion) => sameArray(completion.order, lower.order))
  };
}

export function oracleAllowsComplete(
  lower: Readonly<{
    readonly members: readonly string[];
    readonly claims: Readonly<Record<string, OracleClaim>>;
    readonly order: readonly string[];
  }>,
  completions: readonly OracleCompletion[]
): boolean {
  const stability = oracleStability(lower, completions);
  return stability.membership && stability.claim && stability.order;
}

export function oracleSandwichHolds(input: Readonly<{
  readonly lower: ReadonlySet<string>;
  readonly upper: ReadonlySet<string> | "unbounded";
  readonly completions: readonly OracleCompletion[];
}>): boolean {
  return input.completions.every((completion) => {
    const members = oracleLegalMembers(completion);
    for (const id of input.lower) {
      if (!members.has(id)) return false;
    }
    if (input.upper === "unbounded") return true;
    for (const id of members) {
      if (!input.upper.has(id)) return false;
    }
    return true;
  });
}

function completionOf(model: SourceModel, members: readonly OracleMember[]): OracleCompletion {
  return {
    members,
    claims: claimsOf(model, members),
    order: orderOf(members)
  };
}

function claimsOf(
  model: SourceModel,
  members: readonly OracleMember[]
): Readonly<Record<string, OracleClaim>> {
  return Object.fromEntries(members.map((member) => [
    member.id,
    model.later_refutation === true ? "refuted" : "unknown"
  ]));
}

function isFiniteWorld(world: SourceModel | FiniteWorld): world is FiniteWorld {
  return "seeds" in world && "edges" in world && "id" in world;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameClaims(
  left: Readonly<Record<string, OracleClaim>>,
  right: Readonly<Record<string, OracleClaim>>
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? "unknown") !== (right[key] ?? "unknown")) return false;
  }
  return true;
}
