import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  type Derivation,
  type ProductStateKey,
  type QueryProgram,
  type Transition,
  type Witness
} from "@do-soul/alaya-protocol";
import type { QueryRelation } from "../query/compile-query.js";
import {
  joinHyperedgeAnd,
  joinHyperedgeOr,
  type HyperedgePremise
} from "../reference/accepting-projection.js";
import { decideGuards, encodeBindingContext, parseBindingContext, unifyBinding, type BoundSourceFacts } from "./binding-environment.js";
import { joinDerivation, leafDerivation, mergeDerivations } from "./path-derivation.js";
import {
  ACCEPTING_PROGRAM_STATE,
  advancesFor,
  compileProgramAutomaton
} from "./program-automaton.js";
import {
  inactiveResolution,
  relationMatches,
  relationStrength,
  unifyAdvance,
  type AdjacencyRow,
  type NamedKindOverlay
} from "./path-matching.js";

export type HyperedgeCompletion = Readonly<{
  readonly from: ProductStateKey;
  readonly to: ProductStateKey;
  readonly relation_kind: string;
  readonly strength_milligrades: number;
  readonly validity: Transition["validity"];
  readonly join?: "and" | "or";
}>;

export type HyperedgeEffect = Readonly<{
  readonly observation_id: string;
  readonly hyperedge_premises: readonly HyperedgePremise[];
  readonly hyperedge: HyperedgeCompletion;
  readonly derivation: Derivation;
  readonly derivations: readonly Derivation[];
}>;

type PremiseAssignment = HyperedgePremise & Readonly<{
  readonly target_object_id: string;
  readonly milligrades: number;
  readonly validity: Transition["validity"];
  readonly relation_kind: string;
  readonly observation_id: string;
  readonly leaf_id: string;
  readonly derivation: Derivation;
  readonly derivations: readonly Derivation[];
}>;

export function tryCompleteHyperedge(
  premises: readonly HyperedgePremise[],
  completion: HyperedgeCompletion
): Transition | undefined {
  if (completion.join === "or") {
    if (joinHyperedgeOr(orWitnesses(premises, completion)).length === 0) return undefined;
  } else if (!joinHyperedgeAnd(premises)) {
    return undefined;
  }
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    from: completion.from,
    to: completion.to,
    relation_kind: completion.relation_kind,
    strength_milligrades: completion.strength_milligrades,
    validity: completion.validity,
    applicable: true
  };
}

export function hyperedgeEffects(
  rows: readonly AdjacencyRow[],
  program: Extract<QueryProgram, { readonly kind: "hyperedge" }>,
  input: Readonly<{
    readonly liveStates: readonly ProductStateKey[];
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly toProgramStates?: readonly string[];
  }>
): readonly HyperedgeEffect[] {
  const toProgramStates = input.toProgramStates ?? [ACCEPTING_PROGRAM_STATE];
  const effects: HyperedgeEffect[] = [];
  for (const from of input.liveStates) {
    const grouped = program.premises.map((premise) =>
      assignmentsForPremise(premise, from, rows, input)
    );
    if (program.join === "or") {
      effects.push(...orHyperedgeEffects(from, grouped, toProgramStates));
    } else {
      effects.push(...andHyperedgeEffects(from, grouped, toProgramStates));
    }
  }
  return Object.freeze(effects);
}

function assignmentsForPremise(
  premise: QueryProgram,
  from: ProductStateKey,
  rows: readonly AdjacencyRow[],
  input: Readonly<{
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
  }>
): readonly PremiseAssignment[] {
  if (premise.kind === "alternative") {
    return premise.options.flatMap((option) => assignmentsForPremise(option, from, rows, input));
  }
  if (premise.kind === "relation") return relationAssignments(premise, from, rows, input);
  if (premise.kind === "empty") return [];
  if (premise.kind === "epsilon") {
    return [terminalAssignment(from, from.object_id, MILLIGRADE_TOP, openValidity(), "epsilon")];
  }
  if (premise.kind === "hyperedge") {
    return nestedHyperedgeAssignments(premise, from, rows, input);
  }
  return walkCompiledPremise(premise, from, rows, input);
}

function relationAssignments(
  relation: QueryRelation,
  from: ProductStateKey,
  rows: readonly AdjacencyRow[],
  input: Readonly<{
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
  }>
): readonly PremiseAssignment[] {
  const found: PremiseAssignment[] = [];
  for (const row of rows) {
    const assignment = assignmentFromRow(relation, from, row, input);
    if (assignment !== undefined) found.push(assignment);
  }
  return found;
}

function nestedHyperedgeAssignments(
  program: Extract<QueryProgram, { readonly kind: "hyperedge" }>,
  from: ProductStateKey,
  rows: readonly AdjacencyRow[],
  input: Readonly<{
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
  }>
): readonly PremiseAssignment[] {
  return hyperedgeEffects(rows, program, {
    liveStates: [from],
    overlay: input.overlay,
    sourceFacts: input.sourceFacts
  }).map((effect) => {
    const assigned = terminalAssignment(
      from,
      effect.hyperedge.to.object_id,
      effect.hyperedge.strength_milligrades,
      effect.hyperedge.validity,
      effect.hyperedge.relation_kind,
      effect.hyperedge.to.binding_context,
      effect.observation_id
    );
    return {
      ...assigned,
      derivation: effect.derivation,
      derivations: effect.derivations
    };
  });
}

function walkCompiledPremise(
  program: QueryProgram,
  from: ProductStateKey,
  rows: readonly AdjacencyRow[],
  input: Readonly<{
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
  }>
): readonly PremiseAssignment[] {
  const automaton = compileProgramAutomaton(program);
  const queue: WalkNode[] = automaton.start.map((programState) => ({
    objectId: from.object_id,
    programState,
    milligrades: MILLIGRADE_TOP,
    validity: openValidity(),
    binding: from.binding_context
  }));
  const seen = new Set<string>();
  const found: PremiseAssignment[] = [];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    const key = `${node.objectId}\0${node.programState}\0${node.binding}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (node.programState === ACCEPTING_PROGRAM_STATE) {
      found.push(terminalAssignment(
        from, node.objectId, node.milligrades, node.validity, "path", node.binding
      ));
    }
    const here = { ...from, object_id: node.objectId, binding_context: node.binding };
    for (const hyperedge of automaton.hyperedgeAdvances) {
      if (hyperedge.from !== node.programState) continue;
      for (const effect of hyperedgeEffects(rows, hyperedge.hyperedge, {
        liveStates: [here],
        overlay: input.overlay,
        sourceFacts: input.sourceFacts,
        toProgramStates: hyperedge.to
      })) {
        const milligrades = effect.hyperedge.strength_milligrades < node.milligrades
          ? effect.hyperedge.strength_milligrades
          : node.milligrades;
        for (const programState of hyperedge.to) {
          queue.push({
            objectId: effect.hyperedge.to.object_id,
            programState,
            milligrades,
            validity: effect.hyperedge.validity,
            binding: effect.hyperedge.to.binding_context
          });
        }
      }
    }
    for (const advance of advancesFor(automaton, node.programState, () => true)) {
      for (const row of rows) {
        const assignment = assignmentFromRow(advance.relation, here, row, input);
        if (assignment === undefined) continue;
        const milligrades = assignment.milligrades < node.milligrades
          ? assignment.milligrades
          : node.milligrades;
        for (const programState of advance.to) {
          queue.push({
            objectId: assignment.target_object_id,
            programState,
            milligrades,
            validity: assignment.validity,
            binding: assignment.binding_context
          });
        }
      }
    }
  }
  return found;
}

type WalkNode = Readonly<{
  readonly objectId: string;
  readonly programState: string;
  readonly milligrades: number;
  readonly validity: Transition["validity"];
  readonly binding: string;
}>;

function openValidity(): Transition["validity"] {
  return { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
}

function terminalAssignment(
  from: ProductStateKey,
  target: string,
  milligrades: number,
  validity: Transition["validity"],
  relationKind: string,
  binding = from.binding_context,
  leafId = `${from.object_id}:${target}:${relationKind}`
): PremiseAssignment {
  const derivation = leafDerivation({
    derivation_id: `leaf:${leafId}`,
    observation_id: leafId,
    leaf_id: leafId
  });
  return {
    hypothesis_id: from.hypothesis_id,
    binding_context: binding,
    time_state: from.time_state,
    present: true,
    target_object_id: target,
    milligrades,
    validity,
    relation_kind: relationKind,
    observation_id: leafId,
    leaf_id: leafId,
    derivation,
    derivations: [derivation]
  };
}

function assignmentFromRow(
  relation: QueryRelation,
  from: ProductStateKey,
  row: AdjacencyRow,
  input: Readonly<{
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
  }>
): PremiseAssignment | undefined {
  if (row.sourceObjectId !== from.object_id) return undefined;
  if (!relationMatches(relation.relation_kind, row.predicate)) return undefined;
  if (row.validity === undefined || inactiveResolution(row.resolutionKind)) return undefined;
  const unified = unifyAdvance(from, relation, row);
  if (unified === undefined) return undefined;
  const decision = decideGuards(
    [relation.guard],
    unified.env,
    input.sourceFacts ?? new Map(),
    { sourceId: row.sourceObjectId, targetId: row.targetObjectId }
  );
  if (decision !== "true") return undefined;
  const strength = relationStrength(relation, input.overlay, row.predicate);
  if (strength === undefined || !strength.applicable) return undefined;
  if (strength.milligrades <= relation.threshold_milligrades) return undefined;
  const leafId = row.assertionId;
  const derivation = leafDerivation({
    derivation_id: `leaf:${leafId}`,
    observation_id: leafId,
    leaf_id: leafId
  });
  return {
    hypothesis_id: from.hypothesis_id,
    binding_context: unified.binding,
    time_state: from.time_state,
    present: true,
    target_object_id: row.targetObjectId,
    milligrades: strength.milligrades,
    validity: row.validity,
    relation_kind: row.predicate,
    observation_id: leafId,
    leaf_id: leafId,
    derivation,
    derivations: [derivation]
  };
}

function orHyperedgeEffects(
  from: ProductStateKey,
  grouped: readonly (readonly PremiseAssignment[])[],
  toProgramStates: readonly string[]
): readonly HyperedgeEffect[] {
  return grouped.flatMap((options) => options.flatMap((option) => completionEffects(from, [option], {
    target: option.target_object_id,
    milligrades: option.milligrades,
    validity: option.validity,
    relation_kind: option.relation_kind,
    join: "or",
    binding: option.binding_context
  }, toProgramStates)));
}

function andHyperedgeEffects(
  from: ProductStateKey,
  grouped: readonly (readonly PremiseAssignment[])[],
  toProgramStates: readonly string[]
): readonly HyperedgeEffect[] {
  if (grouped.some((group) => group.length === 0)) return [];
  const effects: HyperedgeEffect[] = [];
  for (const combo of cartesian(grouped)) {
    const merged = mergeAssignments(combo);
    if (merged === undefined) continue;
    const first = merged[0];
    if (first === undefined) continue;
    effects.push(...completionEffects(from, merged, {
      target: first.target_object_id,
      milligrades: bottleneck(merged),
      validity: first.validity,
      relation_kind: first.relation_kind,
      join: "and",
      binding: first.binding_context
    }, toProgramStates));
  }
  return effects;
}

function completionEffects(
  from: ProductStateKey,
  premises: readonly PremiseAssignment[],
  spec: Readonly<{
    readonly target: string;
    readonly milligrades: number;
    readonly validity: Transition["validity"];
    readonly relation_kind: string;
    readonly join: "and" | "or";
    readonly binding: string;
  }>,
  toProgramStates: readonly string[]
): readonly HyperedgeEffect[] {
  const children = premises.map((premise) => premise.derivation);
  const derivation = joinDerivation(spec.join, children);
  const derivations = mergeDerivations([
    ...premises.flatMap((premise) => premise.derivations),
    derivation
  ]);
  return toProgramStates.map((programState) => {
    const to: ProductStateKey = {
      ...from,
      object_id: spec.target,
      program_state: programState,
      binding_context: spec.binding
    };
    return {
      observation_id: `hyperedge:${from.object_id}:${from.hypothesis_id}:${from.program_state}:${programState}:${spec.join}:${spec.relation_kind}:${spec.target}`,
      hyperedge_premises: premises.map((premise) => ({
        hypothesis_id: premise.hypothesis_id,
        binding_context: premise.binding_context,
        time_state: premise.time_state,
        present: true
      })),
      hyperedge: {
        from,
        to,
        relation_kind: spec.relation_kind,
        strength_milligrades: spec.milligrades,
        validity: spec.validity,
        join: spec.join
      },
      derivation,
      derivations
    };
  });
}

function mergeAssignments(combo: readonly PremiseAssignment[]): PremiseAssignment[] | undefined {
  const first = combo[0];
  if (first === undefined) return undefined;
  let env = parseBindingContext(first.binding_context);
  for (const other of combo.slice(1)) {
    if (other.hypothesis_id !== first.hypothesis_id || other.time_state !== first.time_state) {
      return undefined;
    }
    for (const [variable, value] of parseBindingContext(other.binding_context)) {
      const next = unifyBinding(env, variable, value);
      if (next === undefined) return undefined;
      env = next;
    }
  }
  const merged = encodeBindingContext(env);
  return combo.map((row) => ({ ...row, binding_context: merged }));
}

function cartesian<T>(groups: readonly (readonly T[])[]): T[][] {
  return groups.reduce<T[][]>(
    (acc, group) => acc.flatMap((prefix) => group.map((item) => [...prefix, item])),
    [[]]
  );
}

function bottleneck(assignments: readonly PremiseAssignment[]): number {
  if (assignments.length === 0) return MILLIGRADE_BOTTOM;
  let grade = MILLIGRADE_TOP;
  for (const row of assignments) {
    if (row.milligrades < grade) grade = row.milligrades;
  }
  return grade;
}

function orWitnesses(
  premises: readonly HyperedgePremise[],
  completion: HyperedgeCompletion
): readonly Witness[] {
  return premises.map((premise, index) => ({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    witness_id: `or-${String(index)}`,
    premises: [completion.from.object_id, completion.to.object_id],
    cost: 1,
    complete: premise.present
  }));
}
