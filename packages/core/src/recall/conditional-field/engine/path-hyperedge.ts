import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  HARD_IDENTITY_TRANSFER_ID,
  HARD_IDENTITY_TRANSFER_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  productSubjectId,
  retargetMemoryProduct,
  type Derivation,
  type ProductStateKey,
  type QueryProgram,
  type Transition,
  type Witness
} from "@do-soul/alaya-protocol";
import { hardIdentityCapContractId } from "../cap-contract.js";
import type { QueryRelation } from "../query/compile-query.js";
import {
  joinHyperedgeAnd,
  joinHyperedgeOr,
  type HyperedgePremise
} from "../reference/accepting-projection.js";
import { decideGuards, encodeBindingContext, parseBindingContext, unifyBinding, type BoundSourceFacts } from "./binding-environment.js";
import { joinDerivation, leafDerivation } from "./path-derivation.js";
import { groundedOutputDerivations } from "./output-derivations.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import { transitionKey } from "./path-composition.js";
import type { PathComputation } from "./path-effect-cursor.js";
import type { RetainedRows } from "./retained-sequence.js";
import {
  ACCEPTING_PROGRAM_STATE,
  advancesFor,
  compileProgramAutomaton
} from "./program-automaton.js";
import {
  inactiveResolution,
  observedTargetRevision,
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
  readonly cap_contract_id?: string;
  readonly transfer_id?: string;
  readonly transfer_version?: string;
}>;

export type HyperedgeEffect = Readonly<{
  readonly observation_id: string;
  readonly hyperedge_premises?: readonly HyperedgePremise[];
  readonly hyperedge?: HyperedgeCompletion;
  readonly derivation?: Derivation;
  readonly derivations?: readonly Derivation[];
  readonly unresolved_guard?: boolean;
  readonly missing_target_revision?: boolean;
}>;

type HyperedgeInput = Readonly<{
  readonly query_id: string;
  readonly liveStates: RetainedRows<ProductStateKey>;
  readonly overlay: NamedKindOverlay;
  readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
  readonly toProgramStates?: readonly string[];
  readonly observedStates?: RetainedRows<ProductStateKey>;
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
  readonly cap_contract_id?: string;
  readonly transfer_id?: string;
  readonly transfer_version?: string;
  readonly instance_id?: string;
  readonly revision_id?: string;
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
    applicable: true,
    ...(completion.cap_contract_id === undefined ? {} : { cap_contract_id: completion.cap_contract_id }),
    ...(completion.transfer_id === undefined ? {} : { transfer_id: completion.transfer_id }),
    ...(completion.transfer_version === undefined ? {} : { transfer_version: completion.transfer_version })
  };
}

export function* hyperedgeEffectSteps(
  rows: Iterable<AdjacencyRow>,
  program: Extract<QueryProgram, { readonly kind: "hyperedge" }>,
  input: HyperedgeInput
): PathComputation<void> {
  const toProgramStates = input.toProgramStates ?? [ACCEPTING_PROGRAM_STATE];
  for (const from of input.liveStates) {
    yield { kind: "work" };
    if (from.target.kind !== "memory_entry") continue;
    const grouped: (readonly PremiseAssignment[])[] = [];
    for (const premise of program.premises) {
      const assignments = yield* assignmentsForPremise(premise, from, rows, input);
      grouped.push(yield* shareCompatibleAssignments(assignments));
    }
    if (program.join === "or") {
      yield* orHyperedgeEffects(from, grouped, toProgramStates, input);
    } else {
      yield* andHyperedgeEffects(from, grouped, toProgramStates, input);
    }
  }
}

function* shareCompatibleAssignments(assignments: readonly PremiseAssignment[]): PathComputation<readonly PremiseAssignment[]> {
  const grouped = new Map<string, PremiseAssignment[]>();
  for (const assignment of assignments) {
    const key = JSON.stringify([assignment.hypothesis_id, assignment.binding_context, assignment.time_state,
      assignment.target_object_id, assignment.validity]);
    const group = grouped.get(key) ?? [];
    group.push(assignment);
    grouped.set(key, group);
    yield { kind: "work", retained_bytes: 96 + Buffer.byteLength(key, "utf8") };
  }
  const shared: PremiseAssignment[] = [];
  for (const group of grouped.values()) {
    const first = group[0]!;
    let root = first.derivation;
    let grade = first.milligrades;
    yield { kind: "work", retained_bytes: first.derivations.length * 72 + 256 };
    const forest = new Map<string, Derivation>();
    for (const row of first.derivations) { yield { kind: "work" }; forest.set(row.derivation_id, row); }
    for (let index = 1; index < group.length; index += 1) {
      const assignment = group[index]!;
      root = joinDerivation("or", [root, assignment.derivation]);
      grade = Math.max(grade, assignment.milligrades);
      for (const row of assignment.derivations) { yield { kind: "work", retained_bytes: 72 }; forest.set(row.derivation_id, row); }
      forest.set(root.derivation_id, root);
      yield { kind: "work", retained_bytes: Buffer.byteLength(JSON.stringify(root), "utf8") };
    }
    const nodes: Derivation[] = [];
    for (const row of forest.values()) { yield { kind: "work", retained_bytes: 8 }; nodes.push(row); }
    shared.push({ ...first, milligrades: grade, derivation: root, derivations: nodes });
  }
  return shared;
}

function* assignmentsForPremise(
  premise: QueryProgram,
  from: ProductStateKey,
  rows: Iterable<AdjacencyRow>,
  input: HyperedgeInput
): PathComputation<readonly PremiseAssignment[]> {
  if (premise.kind === "alternative") {
    const assignments: PremiseAssignment[] = [];
    for (const option of premise.options) for (const assignment of yield* assignmentsForPremise(option, from, rows, input)) {
      yield { kind: "work", retained_bytes: 8 }; assignments.push(assignment);
    }
    return assignments;
  }
  if (premise.kind === "relation") return yield* relationAssignments(premise, from, rows, input);
  if (premise.kind === "empty") return [];
  if (premise.kind === "epsilon") {
    return [terminalAssignment(from, productSubjectId(from), MILLIGRADE_TOP, openValidity(), "epsilon")];
  }
  if (premise.kind === "hyperedge") {
    return yield* nestedHyperedgeAssignments(premise, from, rows, input);
  }
  return yield* walkCompiledPremise(premise, from, rows, input);
}

function* relationAssignments(
  relation: QueryRelation,
  from: ProductStateKey,
  rows: Iterable<AdjacencyRow>,
  input: HyperedgeInput
): PathComputation<readonly PremiseAssignment[]> {
  const found: PremiseAssignment[] = [];
  for (const row of rows) {
    const assignment = assignmentFromRow(relation, from, row, input);
    if (assignment !== undefined) found.push(assignment);
    yield { kind: "work", retained_bytes: assignment === undefined ? 0 : Buffer.byteLength(JSON.stringify(assignment), "utf8") };
  }
  return found;
}

function* nestedHyperedgeAssignments(
  program: Extract<QueryProgram, { readonly kind: "hyperedge" }>,
  from: ProductStateKey,
  rows: Iterable<AdjacencyRow>,
  input: HyperedgeInput
): PathComputation<readonly PremiseAssignment[]> {
  const assignments: PremiseAssignment[] = [];
  for (const step of hyperedgeEffectSteps(rows, program, {
    query_id: input.query_id,
    liveStates: [from],
    overlay: input.overlay,
    sourceFacts: input.sourceFacts,
    observedStates: input.observedStates ?? input.liveStates
  })) {
    if (step.kind === "work") { yield step; continue; }
    const effect = step.effect;
    if (effect.hyperedge === undefined || effect.derivation === undefined) continue;
    const assigned = terminalAssignment(
      from,
      productSubjectId(effect.hyperedge.to),
      effect.hyperedge.strength_milligrades,
      effect.hyperedge.validity,
      effect.hyperedge.relation_kind,
      effect.hyperedge.to.binding_context,
      effect.observation_id
    );
    assignments.push({
      ...assigned,
      derivation: effect.derivation,
      derivations: effect.derivations ?? [effect.derivation]
    });
  }
  return assignments;
}

function* walkCompiledPremise(
  program: QueryProgram,
  from: ProductStateKey,
  rows: Iterable<AdjacencyRow>,
  input: HyperedgeInput
): PathComputation<readonly PremiseAssignment[]> {
  if (from.target.kind !== "memory_entry") return [];
  yield { kind: "work", retained_bytes: 1024 + Buffer.byteLength(JSON.stringify(program), "utf8") * 8 };
  const automaton = compileProgramAutomaton(program);
  const starts = automaton.start.map((program_state) => ({ ...from, program_state }));
  const queue: ProductStateKey[] = [...starts];
  const visited = new Map<string, ProductStateKey>();
  const transitions: Transition[] = [];
  const derivations = new Map<string, Derivation>();
  const roots: Record<string, string> = {};
  const observed = input.observedStates ?? input.liveStates;
  const retain = function* (node: ProductStateKey, assignment: PremiseAssignment, nextStates: readonly string[]): PathComputation<void> {
    const revision = observedTargetRevision(assignment.target_object_id, input.sourceFacts, observed);
    if (revision === undefined || node.target.kind !== "memory_entry") return;
    for (const programState of nextStates) {
      yield { kind: "work", retained_bytes: 1024 };
      const to = retargetMemoryProduct(node, { object_id: assignment.target_object_id, source_revision: revision,
        program_state: programState, binding_context: assignment.binding_context });
      const edge: Transition = { schema_version: 1, from: node, to, applicable: true,
        relation_kind: assignment.relation_kind, instance_id: assignment.instance_id ?? assignment.derivation.derivation_id,
        ...(assignment.revision_id === undefined ? {} : { revision_id: assignment.revision_id }),
        ...(assignment.transfer_id === undefined ? {} : { transfer_id: assignment.transfer_id }),
        ...(assignment.transfer_version === undefined ? {} : { transfer_version: assignment.transfer_version }),
        strength_milligrades: assignment.milligrades, validity: assignment.validity,
        ...(assignment.cap_contract_id === undefined ? {} : { cap_contract_id: assignment.cap_contract_id }) };
      transitions.push(edge);
      roots[transitionKey(edge)] = assignment.derivation.derivation_id;
      for (const row of assignment.derivations) { yield { kind: "work", retained_bytes: 72 }; derivations.set(row.derivation_id, row); }
      queue.push(to);
    }
  };
  for (let offset = 0; offset < queue.length; offset += 1) {
    const node = queue[offset]!;
    const key = productStateNodeId(node);
    if (visited.has(key)) continue;
    visited.set(key, node);
    yield { kind: "work", retained_bytes: Buffer.byteLength(key, "utf8") + 96 };
    const env = parseBindingContext(node.binding_context);
    for (const variable of automaton.localVariables.get(node.program_state) ?? []) env.delete(variable);
    const here = { ...node, binding_context: encodeBindingContext(env) };
    for (const hyperedge of automaton.hyperedgeAdvances) {
      if (hyperedge.from !== node.program_state) continue;
      for (const step of hyperedgeEffectSteps(rows, hyperedge.hyperedge, {
        query_id: input.query_id,
        liveStates: [here],
        overlay: input.overlay,
        sourceFacts: input.sourceFacts,
        toProgramStates: hyperedge.to,
        observedStates: observed
      })) {
        if (step.kind === "work") { yield step; continue; }
        const effect = step.effect;
        if (effect.hyperedge === undefined || effect.derivation === undefined) continue;
        const assignment = terminalAssignment(node, productSubjectId(effect.hyperedge.to), effect.hyperedge.strength_milligrades,
          effect.hyperedge.validity, effect.hyperedge.relation_kind, effect.hyperedge.to.binding_context);
        yield* retain(node, { ...assignment, derivation: effect.derivation, derivations: effect.derivations ?? [effect.derivation] }, hyperedge.to);
        yield { kind: "work", retained_bytes: Buffer.byteLength(JSON.stringify(assignment), "utf8") };
      }
    }
    for (const advance of advancesFor(automaton, node.program_state, () => true)) {
      for (const row of rows) {
        const assignment = assignmentFromRow(advance.relation, here, row, input);
        yield { kind: "work", retained_bytes: assignment === undefined ? 0 : Buffer.byteLength(JSON.stringify(assignment), "utf8") };
        if (assignment === undefined) continue;
        yield* retain(node, assignment, advance.to);
      }
    }
  }
  const groundDerivations: Derivation[] = [];
  for (const row of derivations.values()) { yield { kind: "work", retained_bytes: 8 }; groundDerivations.push(row); }
  const groundInput = { seeds: starts.map((state) => ({ schema_version: 1 as const, state, milligrades: MILLIGRADE_TOP })),
    transitions, derivations: groundDerivations, transition_derivations: roots, allowance: 1 };
  let grounded = groundedOutputDerivations(groundInput);
  while (!grounded.complete) {
    yield { kind: "work", retained_bytes: Math.max(0, grounded.retained_bytes) };
    grounded = groundedOutputDerivations({ ...groundInput, progress: grounded.progress });
  }
  yield { kind: "work", retained_bytes: Math.max(0, grounded.retained_bytes) };
  const forest: Derivation[] = [];
  for (const row of grounded.progress.forest.values()) { yield { kind: "work", retained_bytes: 8 }; forest.push(row); }
  const assignments: PremiseAssignment[] = [];
  for (const [key, node] of visited) {
    yield { kind: "work", retained_bytes: 256 };
    if (node.program_state !== ACCEPTING_PROGRAM_STATE) continue;
    const rootId = grounded.progress.root_map.get(key)?.[0];
    const root = rootId === undefined ? undefined : grounded.progress.forest.get(rootId);
    const grade = grounded.progress.grades.get(key);
    if (root === undefined || grade === undefined) continue;
    assignments.push({ ...terminalAssignment(from, productSubjectId(node), grade, openValidity(), "path", node.binding_context),
      derivation: root, derivations: forest });
  }
  return assignments;
}

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
  leafId = `${productSubjectId(from)}:${target}:${relationKind}`
): PremiseAssignment {
  const derivation = leafDerivation({
    derivation_id: `leaf:${leafId}`,
    observation_id: leafId,
    leaf_id: leafId,
    association_milligrades: milligrades
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
    derivations: [derivation],
    cap_contract_id: hardIdentityCapContractId(),
    transfer_id: HARD_IDENTITY_TRANSFER_ID,
    transfer_version: HARD_IDENTITY_TRANSFER_VERSION
  };
}

function assignmentFromRow(
  relation: QueryRelation,
  from: ProductStateKey,
  row: AdjacencyRow,
  input: Readonly<{
    readonly query_id: string;
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
  }>
): PremiseAssignment | undefined {
  if (row.sourceObjectId !== productSubjectId(from)) return undefined;
  if (!relationMatches(relation.relation_kind, row.predicate)) return undefined;
  if (row.validity === undefined || inactiveResolution(row.resolutionKind)) return undefined;
  const declared = input.overlay[row.predicate] ?? input.overlay[relation.relation_kind];
  if (declared?.applicable === false) return undefined;
  const unified = unifyAdvance(from, relation, row);
  if (unified === undefined) return undefined;
  const decision = decideGuards(
    [relation.guard],
    unified.env,
    input.sourceFacts ?? new Map(),
    { sourceId: row.sourceObjectId, targetId: row.targetObjectId }
  );
  if (decision !== "true") return undefined;
  const revisionId = row.source_revision
    ?? input.sourceFacts?.get(row.sourceObjectId)?.source_revision
    ?? (from.target.kind === "memory_entry" ? from.target.source_revision : undefined);
  const strength = relationStrength(relation, input.overlay, row.predicate, {
    query_id: input.query_id,
    instance_id: row.assertionId,
    revision_id: revisionId,
    hypothesis_id: from.hypothesis_id,
    binding: unified.binding,
    time_state: from.time_state
  });
  if (strength === undefined) return undefined;
  if (strength.milligrades <= relation.threshold_milligrades) return undefined;
  const leafId = row.assertionId;
  const derivation = leafDerivation({
    derivation_id: `leaf:${leafId}`,
    observation_id: leafId,
    leaf_id: leafId,
    association_milligrades: strength.milligrades,
    source_revision: revisionId
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
    derivations: [derivation],
    cap_contract_id: strength.cap_contract_id,
    transfer_id: strength.transfer_id,
    transfer_version: strength.transfer_version,
    instance_id: strength.instance_id,
    revision_id: strength.revision_id
  };
}

function* orHyperedgeEffects(
  from: ProductStateKey,
  grouped: readonly (readonly PremiseAssignment[])[],
  toProgramStates: readonly string[],
  input: HyperedgeInput
): PathComputation<void> {
  for (const options of grouped) for (const option of options) {
    yield { kind: "work", retained_bytes: completionReservation([option]) };
    for (const effect of yield* completionEffects(from, [option], {
    target: option.target_object_id,
    milligrades: option.milligrades,
    validity: option.validity,
    relation_kind: option.relation_kind,
    join: "or",
    binding: option.binding_context,
    cap_contract_id: option.cap_contract_id,
    transfer_id: option.transfer_id,
    transfer_version: option.transfer_version
    }, toProgramStates, input)) yield { kind: "effect", effect };
  }
}

function* andHyperedgeEffects(
  from: ProductStateKey,
  grouped: readonly (readonly PremiseAssignment[])[],
  toProgramStates: readonly string[],
  input: HyperedgeInput
): PathComputation<void> {
  if (grouped.some((group) => group.length === 0)) return;
  for (const combo of cartesian(grouped)) {
    yield { kind: "work" };
    const merged = mergeAssignments(combo);
    if (merged === undefined) continue;
    const first = merged[0];
    if (first === undefined) continue;
    const grade = bottleneck(merged);
    if (grade === undefined) continue;
    yield { kind: "work", retained_bytes: completionReservation(merged) };
    for (const effect of yield* completionEffects(from, merged, {
      target: first.target_object_id,
      milligrades: grade,
      validity: first.validity,
      relation_kind: first.relation_kind,
      join: "and",
      binding: first.binding_context,
      cap_contract_id: first.cap_contract_id,
      transfer_id: first.transfer_id,
      transfer_version: first.transfer_version
    }, toProgramStates, input)) yield { kind: "effect", effect };
  }
}

function completionReservation(premises: readonly PremiseAssignment[]): number {
  // Includes the temporary deduplication map, child references, and emitted metadata.
  return 2048 + premises.reduce((sum, premise) => sum + 128 + premise.derivations.length * 80, 0);
}

function* completionEffects(
  from: ProductStateKey,
  premises: readonly PremiseAssignment[],
  spec: Readonly<{
    readonly target: string;
    readonly milligrades: number;
    readonly validity: Transition["validity"];
    readonly relation_kind: string;
    readonly join: "and" | "or";
    readonly binding: string;
    readonly cap_contract_id?: string;
    readonly transfer_id?: string;
    readonly transfer_version?: string;
  }>,
  toProgramStates: readonly string[],
  input: HyperedgeInput
): PathComputation<readonly HyperedgeEffect[]> {
  if (from.target.kind !== "memory_entry") {
    return [{
      observation_id: `revision:${productSubjectId(from)}:${from.program_state}:${spec.target}`,
      unresolved_guard: true
    }];
  }
  const targetRevision = observedTargetRevision(
    spec.target,
    input.sourceFacts,
    input.observedStates ?? input.liveStates
  );
  if (targetRevision === undefined) {
    return [{
      observation_id: `revision:${productSubjectId(from)}:${from.program_state}:${spec.target}`,
      unresolved_guard: true,
      missing_target_revision: true
    }];
  }
  const children = premises.map((premise) => premise.derivation);
  const derivation = joinDerivation(spec.join, children);
  const forest = new Map<string, Derivation>();
  for (const premise of premises) for (const row of premise.derivations) {
    yield { kind: "work", retained_bytes: 72 }; forest.set(row.derivation_id, row);
  }
  forest.set(derivation.derivation_id, derivation);
  const derivations: Derivation[] = [];
  for (const row of forest.values()) { yield { kind: "work", retained_bytes: 8 }; derivations.push(row); }
  return toProgramStates.map((programState) => {
    const to: ProductStateKey = retargetMemoryProduct(from, {
      object_id: spec.target,
      program_state: programState,
      binding_context: spec.binding,
      source_revision: targetRevision
    });
    return {
      observation_id: `hyperedge:${productSubjectId(from)}:${from.hypothesis_id}:${from.program_state}:${programState}:${spec.join}:${spec.relation_kind}:${spec.target}`,
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
        join: spec.join,
        ...(spec.cap_contract_id === undefined ? {} : { cap_contract_id: spec.cap_contract_id }),
        ...(spec.transfer_id === undefined ? {} : { transfer_id: spec.transfer_id }),
        ...(spec.transfer_version === undefined ? {} : { transfer_version: spec.transfer_version })
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

function* cartesian<T>(groups: readonly (readonly T[])[], index = 0, prefix: readonly T[] = []): Generator<readonly T[]> {
  if (index === groups.length) { yield prefix; return; }
  for (const item of groups[index]!) yield* cartesian(groups, index + 1, [...prefix, item]);
}

function bottleneck(assignments: readonly PremiseAssignment[]): number | undefined {
  if (assignments.length === 0) return MILLIGRADE_BOTTOM;
  const contracts = new Set(
    assignments.flatMap((row) => row.cap_contract_id === undefined || row.cap_contract_id.length === 0
      ? []
      : [row.cap_contract_id])
  );
  if (contracts.size > 1) return undefined;
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
    premises: [productSubjectId(completion.from), productSubjectId(completion.to)],
    cost: 1,
    complete: premise.present
  }));
}
