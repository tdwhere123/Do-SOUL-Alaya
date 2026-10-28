import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  productEndpointId,
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
import { alignOutgoingBinding, encodeBindingContext, parseBindingContext, unifyBinding, type BoundSourceFacts, type BindingContextStore } from "./binding-environment.js";
import { joinDerivation } from "./path-derivation.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import { transitionKey } from "./path-composition.js";
import type { PathComputation } from "./path-effect-cursor.js";
import { pairDemandRegistered, type RegisteredDemands } from "./path-routing.js";
import {
  assignmentFromRow,
  groundPremiseAssignments,
  queryPremiseValidity,
  terminalAssignment,
  type PremiseAssignment
} from "./premise-assignment.js";
import type { RetainedRows } from "./retained-sequence.js";
import {
  ACCEPTING_PROGRAM_STATE,
  advancesFor,
  compileProgramAutomaton,
  programAutomatonCost,
  type ProgramAutomaton
} from "./program-automaton.js";
import {
  retargetRelationProduct,
  observedTargetRevision,
  relationMatches,
  relationPhysicalCandidates,
  type AdjacencyRow,
  type NamedKindOverlay
} from "./path-matching.js";
import {
  readSequenceReach,
  SEQUENCE_PROGRAM_ID_BYTES,
  sequenceProgramIsCold,
  sequenceReachKey,
  sequenceReachWithoutAssertions,
  writeSequenceReach,
  type UnresolvedHop
} from "./sequence-reach.js";

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
  readonly missing_measurement?: boolean;
  readonly relation_demand?: Readonly<{ readonly subject: string; readonly predicate: string }>;
  readonly source_fact_demand?: string;
}>;

type HyperedgeInput = Readonly<{
  readonly asOf: string;
  readonly bindingContexts?: BindingContextStore;
  readonly query_id: string;
  readonly liveStates: RetainedRows<ProductStateKey>;
  readonly overlay: NamedKindOverlay;
  readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
  readonly toProgramStates?: readonly string[];
  readonly destinationAutomaton?: ProgramAutomaton;
  readonly observedStates?: RetainedRows<ProductStateKey>;
  readonly physicalKinds?: readonly string[];
  readonly physicalKindSet?: ReadonlySet<string>;
  readonly registeredDemands?: RegisteredDemands;
  readonly compiledPremises?: Map<QueryProgram, ProgramAutomaton>;
  readonly joinRows?: readonly AdjacencyRow[];
  /** Stable owner for sequence reach remembered across row deltas. */
  readonly reachOwner?: object;
  /** Old rows whose missing target revision resolved on this pass. */
  readonly promotedIds?: Set<string>;
  /** Programs whose row delta started with no stored reach. Shared for the page. */
  readonly coldPrograms?: Set<string>;
  /** A nested premise still returns proofs this row delta did not touch. */
  readonly retainPopulation?: boolean;
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
  if (input.physicalKindSet === undefined && input.physicalKinds !== undefined) {
    const index = new Set<string>();
    for (const kind of input.physicalKinds) {
      yield { kind: "work", retained_bytes: 64 + Buffer.byteLength(kind, "utf8") };
      index.add(kind);
    }
    input = { ...input, physicalKindSet: index };
  }
  const toProgramStates = input.toProgramStates ?? [ACCEPTING_PROGRAM_STATE];
  if (input.promotedIds === undefined) input = { ...input, promotedIds: new Set() };
  const deltaIds = input.joinRows === undefined ? undefined : new Set(input.joinRows.map((row) => row.assertionId));
  const emitted = new Set<string>();
  for (const from of input.liveStates) {
    yield { kind: "work" };
    const roles: { readonly population: readonly PremiseAssignment[]; readonly delta: readonly PremiseAssignment[] }[] = [];
    for (const premise of program.premises) {
      roles.push(yield* premiseJoinRoles(premise, from, rows, input, deltaIds));
    }
    // A nested premise must still return proofs the sibling delta did not touch.
    const focuses = deltaIds === undefined || input.retainPopulation === true ? [undefined] : roles.map((_, index) => index);
    for (const focus of focuses) {
      const grouped = roles.map((role, index) => focus !== undefined && index === focus ? role.delta : role.population);
      if (program.join === "or") yield* orHyperedgeEffects(from, grouped, toProgramStates, input, deltaIds, emitted);
      else yield* andHyperedgeEffects(from, grouped, toProgramStates, input, deltaIds, emitted);
    }
  }
}

function* premiseJoinRoles(
  premise: QueryProgram,
  from: ProductStateKey,
  rows: Iterable<AdjacencyRow>,
  input: HyperedgeInput,
  deltaIds: ReadonlySet<string> | undefined
): PathComputation<{ readonly population: readonly PremiseAssignment[]; readonly delta: readonly PremiseAssignment[] }> {
  const populationInput = { ...input, joinRows: undefined };
  if (premise.kind === "relation") {
    const population = yield* shareCompatibleAssignments(yield* assignmentsForPremise(premise, from, rows, populationInput));
    if (deltaIds === undefined || input.joinRows === undefined) return { population, delta: population };
    const delta = yield* shareCompatibleAssignments(yield* assignmentsForPremise(premise, from, input.joinRows, input));
    return { population, delta };
  }
  // Share old proofs apart from new ones. An OR across both would mark the old path as new.
  const found = yield* assignmentsForPremise(premise, from, rows,
    deltaIds === undefined ? input : { ...input, retainPopulation: true });
  if (deltaIds === undefined) {
    const population = yield* shareCompatibleAssignments(found);
    return { population, delta: population };
  }
  const retained: PremiseAssignment[] = [];
  const delta: PremiseAssignment[] = [];
  for (const assignment of found) {
    if (assignmentInDelta(assignment, deltaIds, input.promotedIds)) delta.push(assignment);
    else retained.push(assignment);
  }
  const retainedShared = yield* shareCompatibleAssignments(retained);
  const deltaShared = yield* shareCompatibleAssignments(delta);
  return { population: [...retainedShared, ...deltaShared], delta: deltaShared };
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
    for (const option of premise.options) {
      // The caller chose these rows. A relation option must not replace them with the row delta.
      for (const assignment of yield* assignmentsForPremise(option, from, rows, input)) {
        yield { kind: "work", retained_bytes: 8 }; assignments.push(assignment);
      }
    }
    return assignments;
  }
  if (premise.kind === "relation") return yield* relationAssignments(premise, from, rows, input);
  if (premise.kind === "empty") return [];
  if (premise.kind === "epsilon") {
    return [terminalAssignment(from, productEndpointId(from), MILLIGRADE_TOP, queryPremiseValidity(from, input.asOf), "epsilon")];
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
  const physicalKinds = input.physicalKindSet ?? new Set<string>();
  for (const predicate of relationPhysicalCandidates(relation.relation_kind)) {
    yield { kind: "work" };
    if (!physicalKinds.has(predicate) || !relationMatches(relation.relation_kind, predicate)) continue;
    const subject = productEndpointId(from);
    if (pairDemandRegistered(input.registeredDemands, subject, predicate)) continue;
    yield { kind: "effect", effect: { observation_id: `demand:${subject}:${predicate}`,
      relation_demand: { subject, predicate } } };
  }
  for (const row of rows) {
    const assignment = yield* assignmentFromRow(relation, from, row, input);
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
    asOf: input.asOf,
    query_id: input.query_id,
    liveStates: [from],
    overlay: input.overlay,
    sourceFacts: input.sourceFacts,
    bindingContexts: input.bindingContexts,
    observedStates: input.observedStates ?? input.liveStates,
    physicalKinds: input.physicalKinds, physicalKindSet: input.physicalKindSet,
    registeredDemands: input.registeredDemands,
    compiledPremises: input.compiledPremises,
    ...(input.reachOwner === undefined ? {} : { reachOwner: input.reachOwner }),
    ...(input.promotedIds === undefined ? {} : { promotedIds: input.promotedIds }),
    ...(input.coldPrograms === undefined ? {} : { coldPrograms: input.coldPrograms }),
    ...(input.retainPopulation === true ? { retainPopulation: true } : {}),
    ...(input.joinRows === undefined ? {} : { joinRows: input.joinRows })
  })) {
    if (step.kind === "work") { yield step; continue; }
    const effect = step.effect;
    if (effect.hyperedge === undefined || effect.derivation === undefined) { yield step; continue; }
    const assigned = terminalAssignment(
      from,
      productEndpointId(effect.hyperedge.to),
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

type SequenceStep = Readonly<{ node: ProductStateKey; reach: "population" | "join" }>;

type SequenceFrontier = {
  readonly queue: SequenceStep[];
  readonly visited: Map<string, ProductStateKey>;
  readonly transitions: Transition[];
  readonly derivations: Map<string, Derivation>;
  readonly roots: Record<string, string>;
  readonly unresolved: UnresolvedHop[];
  readonly seenUnresolved: Set<string>;
};

function* retainUnresolvedHop(frontier: SequenceFrontier, pair: UnresolvedHop): PathComputation<void> {
  const id = `${productStateNodeId(pair.node)}\0${pair.row.assertionId}\0${pair.relation.relation_kind}`;
  if (frontier.seenUnresolved.has(id)) return;
  yield { kind: "work", retained_bytes: Buffer.byteLength(JSON.stringify([id, pair]), "utf8") };
  frontier.seenUnresolved.add(id);
  frontier.unresolved.push(pair);
}

function* retainSequenceAssignment(
  frontier: SequenceFrontier,
  node: ProductStateKey,
  assignment: PremiseAssignment,
  nextStates: readonly string[],
  successor: SequenceStep["reach"],
  input: HyperedgeInput,
  observed: Iterable<ProductStateKey>
): PathComputation<boolean> {
  const revision = observedTargetRevision(assignment.target_object_id, input.sourceFacts, observed);
  if (revision === undefined) {
    yield { kind: "effect", effect: { observation_id: `revision:${assignment.observation_id}:${node.program_state}`,
      unresolved_guard: true, missing_target_revision: true } };
    return false;
  }
  let retained = false;
  for (const programState of nextStates) {
    yield { kind: "work", retained_bytes: 1024 };
    const to = hyperedgeTarget(node, { object_id: assignment.target_object_id, source_revision: revision,
      program_state: programState, binding_context: assignment.binding_context }, input.sourceFacts);
    const edge: Transition = { schema_version: 1, from: node, to, applicable: true,
      relation_kind: assignment.relation_kind, instance_id: assignment.instance_id ?? assignment.derivation.derivation_id,
      ...(assignment.revision_id === undefined ? {} : { revision_id: assignment.revision_id }),
      ...(assignment.transfer_id === undefined ? {} : { transfer_id: assignment.transfer_id }),
      ...(assignment.transfer_version === undefined ? {} : { transfer_version: assignment.transfer_version }),
      strength_milligrades: assignment.milligrades, validity: assignment.validity,
      ...(assignment.cap_contract_id === undefined ? {} : { cap_contract_id: assignment.cap_contract_id }) };
    frontier.transitions.push(edge);
    retained = true;
    frontier.roots[transitionKey(edge)] = assignment.derivation.derivation_id;
    for (const row of assignment.derivations) { yield { kind: "work", retained_bytes: 72 }; frontier.derivations.set(row.derivation_id, row); }
    frontier.queue.push({ node: to, reach: successor });
  }
  return retained;
}

function* extendSequenceState(
  automaton: ProgramAutomaton,
  step: SequenceStep,
  rows: Iterable<AdjacencyRow>,
  input: HyperedgeInput,
  deltaIds: ReadonlySet<string> | undefined,
  observed: RetainedRows<ProductStateKey>,
  frontier: SequenceFrontier
): PathComputation<void> {
  const node = step.node;
  const key = productStateNodeId(node);
  if (frontier.visited.has(key)) return;
  frontier.visited.set(key, node);
  yield { kind: "work", retained_bytes: Buffer.byteLength(key, "utf8") + 96 };
  const env = parseBindingContext(node.binding_context, input.bindingContexts);
  for (const variable of automaton.localVariables.get(node.program_state) ?? []) env.delete(variable);
  const here = { ...node, binding_context: encodeBindingContext(env, input.bindingContexts) };
  for (const advance of automaton.advancesByState.get(node.program_state) ?? []) {
    yield { kind: "work" };
    const physicalKinds = input.physicalKindSet ?? new Set<string>();
    for (const predicate of relationPhysicalCandidates(advance.relation.relation_kind)) {
      yield { kind: "work" };
      if (!physicalKinds.has(predicate) || !relationMatches(advance.relation.relation_kind, predicate)) continue;
      const subject = productEndpointId(node);
      if (pairDemandRegistered(input.registeredDemands, subject, predicate)) continue;
      yield { kind: "effect", effect: { observation_id: `demand:${subject}:${predicate}`,
        relation_demand: { subject, predicate } } };
    }
  }
  // A state reached by old rows reads only the row delta. New information reads the population.
  const hopRows = step.reach === "join" && input.joinRows !== undefined ? input.joinRows : rows;
  for (const hyperedge of automaton.hyperedgeAdvances) {
    if (hyperedge.from !== node.program_state) continue;
    // A newly reached state must emit proofs whose hops are already retained.
    // Filtering those as an old row delta drops the hyperedge.
    const nestedJoin = step.reach === "population" ? undefined : input.joinRows;
    for (const inner of hyperedgeEffectSteps(rows, hyperedge.hyperedge, {
      asOf: input.asOf,
      query_id: input.query_id,
      liveStates: [here],
      overlay: input.overlay,
      sourceFacts: input.sourceFacts,
      bindingContexts: input.bindingContexts,
      toProgramStates: hyperedge.to,
      destinationAutomaton: automaton,
      observedStates: observed,
      physicalKinds: input.physicalKinds, physicalKindSet: input.physicalKindSet,
      registeredDemands: input.registeredDemands,
      compiledPremises: input.compiledPremises,
      ...(input.reachOwner === undefined ? {} : { reachOwner: input.reachOwner }),
      ...(input.promotedIds === undefined ? {} : { promotedIds: input.promotedIds }),
      ...(input.coldPrograms === undefined ? {} : { coldPrograms: input.coldPrograms }),
      ...(nestedJoin === undefined ? {} : { joinRows: nestedJoin })
    })) {
      if (inner.kind === "work") { yield inner; continue; }
      const effect = inner.effect;
      if (effect.hyperedge === undefined || effect.derivation === undefined) { yield inner; continue; }
      const assignment = terminalAssignment(node, productEndpointId(effect.hyperedge.to), effect.hyperedge.strength_milligrades,
        effect.hyperedge.validity, effect.hyperedge.relation_kind, effect.hyperedge.to.binding_context);
      const carried = { ...assignment, derivation: effect.derivation, derivations: effect.derivations ?? [effect.derivation] };
      const successor = deltaIds !== undefined && assignmentInDelta(carried, deltaIds, input.promotedIds) ? "population" : step.reach;
      yield* retainSequenceAssignment(frontier, node, carried, hyperedge.to, deltaIds === undefined ? "population" : successor, input, observed);
      yield { kind: "work", retained_bytes: Buffer.byteLength(JSON.stringify(assignment), "utf8") };
    }
  }
  for (const advance of advancesFor(automaton, node.program_state, () => true)) {
    for (const row of hopRows) {
      const assignment = yield* assignmentFromRow(advance.relation, here, row, input);
      yield { kind: "work", retained_bytes: assignment === undefined ? 0 : Buffer.byteLength(JSON.stringify(assignment), "utf8") };
      if (assignment === undefined) {
        if (row.sourceObjectId === productEndpointId(here) && relationMatches(advance.relation.relation_kind, row.predicate)
          && observedTargetRevision(row.targetObjectId, input.sourceFacts, observed) === undefined) {
          yield* retainUnresolvedHop(frontier, { here, node, row, relation: advance.relation, nextStates: advance.to });
        }
        continue;
      }
      // A path that already used new information keeps reading retained rows.
      const successor = deltaIds === undefined || step.reach === "population" || deltaIds.has(row.assertionId)
        ? "population" : "join";
      yield* retainSequenceAssignment(frontier, node, assignment, advance.to, successor, input, observed);
    }
  }
}

function* walkCompiledPremise(
  program: QueryProgram,
  from: ProductStateKey,
  rows: Iterable<AdjacencyRow>,
  input: HyperedgeInput
): PathComputation<readonly PremiseAssignment[]> {
  let automaton = input.compiledPremises?.get(program);
  if (automaton === undefined) {
    const cost = programAutomatonCost(program);
    yield { kind: "work", retained_bytes: cost.retained_bytes };
    for (let unit = 0; unit < cost.work_units; unit += 1) yield { kind: "work" };
    automaton = compileProgramAutomaton(program);
    input.compiledPremises?.set(program, automaton);
  }
  const starts = automaton.start.map((program_state) => ({ ...from, program_state }));
  const deltaIds = input.joinRows === undefined ? undefined : new Set(input.joinRows.map((row) => row.assertionId));
  const owner = input.reachOwner;
  const reachKey = owner === undefined ? undefined : sequenceReachKey(program, productStateNodeId(from));
  const prior = owner !== undefined && reachKey !== undefined && deltaIds !== undefined
    ? readSequenceReach(owner, reachKey) : undefined;
  const stored = prior === undefined || deltaIds === undefined ? prior : sequenceReachWithoutAssertions(prior, deltaIds);
  const frontier: SequenceFrontier = {
    queue: [],
    visited: new Map(),
    transitions: stored === undefined ? [] : [...stored.transitions],
    derivations: new Map(stored === undefined ? [] : stored.derivations.map((row) => [row.derivation_id, row])),
    roots: stored === undefined ? {} : { ...stored.roots },
    unresolved: [],
    seenUnresolved: new Set()
  };
  const observed = input.observedStates ?? input.liveStates;
  if (stored === undefined) {
    // A program with no stored reach must not skip retained rows. A new product
    // beside a frontier that already exists only joins the row delta.
    const cold = deltaIds !== undefined && sequenceProgramIsCold(owner, program, input.coldPrograms);
    const reach = deltaIds === undefined || cold ? "population" : "join";
    for (const node of starts) frontier.queue.push({ node, reach });
  } else {
    // States already reached only extend along the row delta. A stored miss is rechecked alone.
    for (const node of stored.states) frontier.queue.push({ node, reach: "join" });
    for (const pair of stored.unresolved) {
      if (deltaIds?.has(pair.row.assertionId) === true) continue;
      const assignment = yield* assignmentFromRow(pair.relation, pair.here, pair.row, input);
      if (assignment === undefined) { yield* retainUnresolvedHop(frontier, pair); continue; }
      const retained = yield* retainSequenceAssignment(frontier, pair.node, assignment, pair.nextStates, "population", input, observed);
      if (retained) input.promotedIds?.add(pair.row.assertionId);
      else yield* retainUnresolvedHop(frontier, pair);
    }
  }
  for (let offset = 0; offset < frontier.queue.length; offset += 1) {
    yield* extendSequenceState(automaton, frontier.queue[offset]!, rows, input, deltaIds, observed, frontier);
  }
  if (owner !== undefined && reachKey !== undefined) {
    yield { kind: "work", retained_bytes: SEQUENCE_PROGRAM_ID_BYTES };
    const states: ProductStateKey[] = [];
    for (const node of frontier.visited.values()) states.push(node);
    writeSequenceReach(owner, reachKey, {
      states, transitions: frontier.transitions, derivations: [...frontier.derivations.values()],
      roots: frontier.roots, unresolved: frontier.unresolved
    });
  }
  return yield* groundPremiseAssignments(from, starts, frontier.visited, frontier.transitions, frontier.derivations, frontier.roots, input.asOf);
}

function* orHyperedgeEffects(
  from: ProductStateKey,
  grouped: readonly (readonly PremiseAssignment[])[],
  toProgramStates: readonly string[],
  input: HyperedgeInput,
  deltaIds?: ReadonlySet<string>,
  emitted?: Set<string>
): PathComputation<void> {
  for (const options of grouped) for (const option of options) {
    if (deltaIds !== undefined && input.retainPopulation !== true && !assignmentInDelta(option, deltaIds, input.promotedIds)) continue;
    if (emitted !== undefined && !claimHyperedge(emitted, from, [option])) continue;
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
  input: HyperedgeInput,
  deltaIds?: ReadonlySet<string>,
  emitted?: Set<string>
): PathComputation<void> {
  if (grouped.some((group) => group.length === 0)) return;
  for (const combo of cartesian(grouped)) {
    if (deltaIds !== undefined && input.retainPopulation !== true
      && !combo.some((assignment) => assignmentInDelta(assignment, deltaIds, input.promotedIds))) continue;
    if (emitted !== undefined && !claimHyperedge(emitted, from, combo)) continue;
    yield { kind: "work" };
    const merged = mergeAssignments(combo, input.bindingContexts);
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

function assignmentInDelta(
  assignment: PremiseAssignment,
  deltaIds: ReadonlySet<string>,
  promotedIds?: ReadonlySet<string>
): boolean {
  const named = (id: string) => deltaIds.has(id) || promotedIds?.has(id) === true;
  if (named(assignment.leaf_id) || (assignment.instance_id !== undefined && named(assignment.instance_id))) return true;
  // The shared forest is on every accepting assignment. Only this derivation's children count.
  const nodes = new Map<string, Derivation>();
  for (const row of assignment.derivations) nodes.set(row.derivation_id, row);
  const pending = [assignment.derivation.derivation_id];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id) ?? (id === assignment.derivation.derivation_id ? assignment.derivation : undefined);
    if (node === undefined) continue;
    for (const leaf of node.leaf_ids) if (named(leaf)) return true;
    for (const child of node.children) pending.push(child);
  }
  return false;
}

function claimHyperedge(emitted: Set<string>, from: ProductStateKey, premises: readonly PremiseAssignment[]): boolean {
  // Leaf ids from a compiled path omit the binding, so two endpoints can still differ.
  const key = `${productStateNodeId(from)}\0${premises.map((premise) => `${premise.binding_context}\0${premise.derivation.derivation_id}`).sort().join("\0")}`;
  if (emitted.has(key)) return false;
  emitted.add(key);
  return true;
}

function completionReservation(premises: readonly PremiseAssignment[]): number {
  // Includes the temporary deduplication map, child references, and emitted metadata.
  return 2048 + premises.reduce((sum, premise) => sum + 128 + premise.derivations.length * 80, 0);
}

function hyperedgeTarget(
  from: ProductStateKey,
  patch: Readonly<{ object_id: string; source_revision: string; program_state: string; binding_context: string }>,
  facts?: ReadonlyMap<string, BoundSourceFacts>
): ProductStateKey {
  return retargetRelationProduct(from, patch.object_id, patch.source_revision, patch, facts);
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
  const targetRevision = observedTargetRevision(
    spec.target,
    input.sourceFacts,
    input.observedStates ?? input.liveStates
  );
  if (targetRevision === undefined) {
    return [{
      observation_id: `revision:${productEndpointId(from)}:${from.program_state}:${spec.target}`,
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
  const effects: HyperedgeEffect[] = [];
  for (const programState of toProgramStates) {
    const binding = input.destinationAutomaton === undefined ? spec.binding : alignOutgoingBinding(
      spec.binding, spec.target, input.destinationAutomaton, programState, input.bindingContexts
    );
    if (binding === undefined) continue;
    const to: ProductStateKey = hyperedgeTarget(from, {
      object_id: spec.target,
      program_state: programState,
      binding_context: binding,
      source_revision: targetRevision
    }, input.sourceFacts);
    effects.push({
      observation_id: `hyperedge:${productEndpointId(from)}:${from.hypothesis_id}:${from.program_state}:${programState}:${spec.join}:${spec.relation_kind}:${spec.target}`,
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
    });
  }
  return effects;
}

function mergeAssignments(combo: readonly PremiseAssignment[], bindingContexts?: BindingContextStore): PremiseAssignment[] | undefined {
  const first = combo[0];
  if (first === undefined) return undefined;
  let env = parseBindingContext(first.binding_context, bindingContexts);
  for (const other of combo.slice(1)) {
    if (other.hypothesis_id !== first.hypothesis_id || other.time_state !== first.time_state) {
      return undefined;
    }
    for (const [variable, value] of parseBindingContext(other.binding_context, bindingContexts)) {
      const next = unifyBinding(env, variable, value);
      if (next === undefined) return undefined;
      env = next;
    }
  }
  const merged = encodeBindingContext(env, bindingContexts);
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
    premises: [productEndpointId(completion.from), productEndpointId(completion.to)],
    cost: 1,
    complete: premise.present
  }));
}
