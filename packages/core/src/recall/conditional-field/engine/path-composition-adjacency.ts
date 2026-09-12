import { createHash } from "node:crypto";
import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  productSubjectId,
  retargetMemoryProduct,
  type Derivation,
  type FacetVector,
  type ProductStateKey,
  type QueryInterpretation,
  type QueryProgram,
  type Transition
} from "@do-soul/alaya-protocol";
import type { HyperedgePremise } from "../reference/accepting-projection.js";
import { collectRelations, type QueryRelation } from "../query/compile-query.js";
import {
  STORED_RELATION_KIND,
  SUPPORTED_RELATION_ALIASES
} from "../query/ordinary-language.js";
import { leafDerivation } from "./path-derivation.js";
import {
  hyperedgeEffectSteps,
  tryCompleteHyperedge,
  type HyperedgeCompletion,
  type HyperedgeEffect
} from "./path-hyperedge.js";
import { PathEffectCursor, type PathComputation } from "./path-effect-cursor.js";
import type { RetainedRows } from "./retained-sequence.js";
import {
  alignOutgoingBinding,
  type BindingContextStore,
  type BoundSourceFacts
} from "./binding-environment.js";
import {
  inactiveResolution,
  relationMatches,
  admitRelationRow,
  type AdjacencyRow,
  type AdmittedRelationStrength,
  type NamedKindOverlay
} from "./path-matching.js";
import {
  routingDiscoveryEffect,
  type RoutingDiscovery
} from "./path-routing.js";
import {
  advancesFor,
  compileProgramAutomaton,
  type ProgramAutomaton
} from "./program-automaton.js";
import { runtimeProgram } from "./path-composition-seed.js";
import { composedFacetPathId, extendFacets } from "./path-composition-facet.js";

export type { HyperedgePremise, HyperedgeCompletion, AdjacencyRow, NamedKindOverlay };
export { tryCompleteHyperedge };

export type CompiledAdjacencyEffect = Readonly<{
  readonly observation_id: string;
  readonly transition?: Transition;
  readonly facet?: FacetVector;
  readonly hyperedge_premises?: readonly HyperedgePremise[];
  readonly hyperedge?: HyperedgeCompletion;
  readonly derivation?: Derivation;
  readonly derivations?: readonly Derivation[];
  readonly missing_measurement?: boolean;
  readonly unresolved_guard?: boolean;
  readonly missing_target_revision?: boolean;
  readonly discovery?: RoutingDiscovery;
}>;

export function programRelationKinds(program: QueryProgram): readonly string[] {
  const runtime = runtimeProgram(program);
  if (runtime === "empty" || runtime === "epsilon") return [];
  return collectRelations(runtime).map((relation) => relation.relation_kind);
}

export function adjacencyKindsFor(
  program: QueryProgram,
  listed: readonly string[] = [],
  routingKinds: readonly string[] = []
): readonly string[] {
  const kinds = programRelationKinds(program);
  const expanded = new Set<string>();
  let openVocabulary = false;
  for (const kind of kinds) {
    if (kind === STORED_RELATION_KIND) openVocabulary = true;
    const aliases = SUPPORTED_RELATION_ALIASES[kind];
    if (aliases === undefined || aliases.length === 0) expanded.add(kind);
    else {
      for (const alias of aliases) expanded.add(alias);
    }
  }
  if (openVocabulary) {
    for (const kind of listed) expanded.add(kind);
  }
  for (const kind of routingKinds) expanded.add(kind);
  return [...expanded];
}

export function adjacencyEffectsForRows(
  rows: Iterable<AdjacencyRow>,
  input: AdjacencyEffectsInput
): readonly CompiledAdjacencyEffect[] {
  const effects: CompiledAdjacencyEffect[] = [];
  for (const step of adjacencyEffectSteps(rows, input)) if (step.kind === "effect") effects.push(step.effect);
  return effects;
}

export type AdjacencyEffectsInput = Readonly<{
    readonly bindingContexts?: BindingContextStore;
    readonly interpretation: QueryInterpretation;
    readonly asOf: string;
    readonly liveStates: RetainedRows<ProductStateKey>;
    readonly liveStateOffset?: number;
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facets?: RetainedRows<FacetVector>;
    readonly discoveries?: RetainedRows<RoutingDiscovery>;
  }>;

export function createAdjacencyEffectCursor(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput): PathEffectCursor;
export function createAdjacencyEffectCursor(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput, memoryLimit: number): PathEffectCursor | undefined;
export function createAdjacencyEffectCursor(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput, memoryLimit = Number.MAX_SAFE_INTEGER): PathEffectCursor | undefined {
  const initialBytes = 8192 + 256;
  if (initialBytes > memoryLimit) return undefined;
  // A pending computation owns this immutable input version. Producers replace
  // versions; retaining their references needs no eager element traversal.
  const bindingContexts = input.bindingContexts?.fork(memoryLimit - initialBytes);
  return new PathEffectCursor(() => adjacencyEffectSteps(rows, { ...input, bindingContexts }), initialBytes, bindingContexts);
}

function* adjacencyEffectSteps(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput): PathComputation<void> {
  const runtime = runtimeProgram(input.interpretation.program);
  if (runtime === "empty" || runtime === "epsilon") return;
  yield { kind: "work", retained_bytes: 1024 + Buffer.byteLength(JSON.stringify(runtime), "utf8") * 8 };
  const automaton = compileProgramAutomaton(runtime);
  for (let index = input.liveStateOffset ?? 0; index < input.liveStates.length; index += 1) {
    yield { kind: "work", retained_bytes: 64 };
    const from = input.liveStates.at(index)!;
    for (const advance of automaton.hyperedgeAdvances) {
      if (advance.from !== from.program_state) continue;
      for (const step of hyperedgeEffectSteps(rows, advance.hyperedge, {
        query_id: input.interpretation.query_id,
        liveStates: [from],
        overlay: input.overlay,
        sourceFacts: input.sourceFacts,
        bindingContexts: input.bindingContexts,
        toProgramStates: advance.to,
        observedStates: input.liveStates
      })) yield step.kind === "work" ? step : { kind: "effect", effect: attachHyperedgeFacet(step.effect) };
    }
  }
  for (const row of rows) {
    if (row.validity === undefined) continue;
    if (inactiveResolution(row.resolutionKind)) continue;
    for (let index = input.liveStateOffset ?? 0; index < input.liveStates.length; index += 1) {
      yield { kind: "work" };
      const from = input.liveStates.at(index)!;
      if (productSubjectId(from) !== row.sourceObjectId) continue;
      yield* effectsForLiveRow(automaton, row, from, {
        query_id: input.interpretation.query_id,
        overlay: input.overlay,
        sourceFacts: input.sourceFacts,
        bindingContexts: input.bindingContexts,
        facets: input.facets,
        liveStates: input.liveStates
      });
    }
  }
  const origins = new Set<string>();
  for (const state of input.liveStates) {
    yield { kind: "work", retained_bytes: 64 };
    origins.add(productSubjectId(state));
  }
  for (const discovery of input.discoveries ?? []) {
    yield { kind: "work", retained_bytes: 64 };
    origins.add(discovery.subject_id);
  }
  const emitted = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      yield { kind: "work", retained_bytes: 128 };
      if (row.validity === undefined || inactiveResolution(row.resolutionKind)
        || !origins.has(row.sourceObjectId) || emitted.has(row.assertionId)) continue;
      for (const effect of routingDiscoveryEffect(row, input.overlay)) {
        emitted.add(row.assertionId);
        if (!origins.has(effect.discovery.subject_id)) { origins.add(effect.discovery.subject_id); grew = true; }
        yield { kind: "effect", effect };
      }
    }
  }
}

function* effectsForLiveRow(
  automaton: ProgramAutomaton,
  row: AdjacencyRow,
  from: ProductStateKey,
  input: Readonly<{
    readonly query_id: string;
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facets?: RetainedRows<FacetVector>;
    readonly liveStates: RetainedRows<ProductStateKey>;
    readonly bindingContexts?: BindingContextStore;
  }>
): PathComputation<void> {
  if (from.target.kind !== "memory_entry") {
    // Terminal evidence product: never retarget into a memory Transition.
    for (const effect of routingDiscoveryEffect(row, input.overlay)) yield { kind: "effect", effect };
    return;
  }
  const matched = advancesFor(automaton, from.program_state, (relation) =>
    relationMatches(relation.relation_kind, row.predicate)
  );
  if (matched.length === 0) {
    // Overlay routing_only nominates physical work. Copying program_state
    // would mint an unadmitted product.
    for (const effect of routingDiscoveryEffect(row, input.overlay)) yield { kind: "effect", effect };
    return;
  }
  for (const advance of matched) {
    yield { kind: "work" };
    yield* effectsForAdvance(automaton, advance, row, from, input);
  }
}

function* effectsForAdvance(
  automaton: ProgramAutomaton,
  advance: Readonly<{ readonly relation: QueryRelation; readonly to: readonly string[] }>,
  row: AdjacencyRow,
  from: ProductStateKey,
  input: Readonly<{
    readonly query_id: string;
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facets?: RetainedRows<FacetVector>;
    readonly liveStates: RetainedRows<ProductStateKey>;
    readonly bindingContexts?: BindingContextStore;
  }>
): PathComputation<void> {
  const admitted = yield* admitRelationRow(advance.relation, from, row, input);
  if (admitted === undefined) return;
  const { binding: unifiedBinding, targetRevision, revisionId, strength } = admitted;
  for (const programState of advance.to) {
    yield { kind: "work" };
    const binding = alignOutgoingBinding(
      unifiedBinding,
      row.targetObjectId,
      automaton,
      programState,
      input.bindingContexts
    );
    if (binding === undefined) continue;
    const to = retargetMemoryProduct(from, {
      object_id: row.targetObjectId,
      program_state: programState,
      binding_context: binding,
      source_revision: targetRevision
    });
    yield* compiledEffects({ ...row, source_revision: revisionId },
      from, to, strength, "true", input.facets ?? []);
  }
}

function* compiledEffects(
  row: AdjacencyRow,
  from: ProductStateKey,
  to: ProductStateKey,
  strength: AdmittedRelationStrength,
  decision: "true" | "unresolved",
  priorFacets: RetainedRows<FacetVector>
): PathComputation<void> {
  if (row.validity === undefined) return;
  const transition: Transition = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    from,
    to,
    relation_kind: row.predicate,
    instance_id: strength.instance_id,
    revision_id: strength.revision_id,
    transfer_id: strength.transfer_id,
    transfer_version: strength.transfer_version,
    strength_milligrades: strength.milligrades,
    validity: row.validity,
    applicable: true,
    cap_contract_id: strength.cap_contract_id
  };
  const vectors = yield* extendFacets(priorFacets, from, to, `${from.program_state}:${to.program_state}:${row.predicate}`, strength.milligrades);
  const derivation = leafDerivation({
    derivation_id: `leaf:${row.assertionId}:${from.program_state}:${to.program_state}`,
    observation_id: row.assertionId,
    leaf_id: row.assertionId,
    association_milligrades: strength.milligrades,
    source_revision: row.source_revision
  });
  for (const [index, facet] of vectors.entries()) {
    yield { kind: "work", retention: "effect_payload",
      retained_bytes: 512 + Buffer.byteLength(JSON.stringify({ transition, derivation, facet }), "utf8") };
    yield { kind: "effect", effect: {
    observation_id: `adjacency:${row.assertionId}:${from.program_state}:${to.program_state}:${String(index)}`,
    transition,
    facet,
    derivation,
    derivations: [derivation],
    unresolved_guard: decision === "unresolved"
    } };
  }
}

function attachHyperedgeFacet(effect: HyperedgeEffect): CompiledAdjacencyEffect {
  if (effect.unresolved_guard === true || effect.hyperedge === undefined) {
    return {
      observation_id: effect.observation_id,
      ...(effect.unresolved_guard === true ? { unresolved_guard: true } : {}),
      ...(effect.missing_measurement === true ? { missing_measurement: true } : {}),
      ...(effect.missing_target_revision === true ? { missing_target_revision: true } : {})
    };
  }
  return {
    observation_id: effect.observation_id,
    hyperedge_premises: effect.hyperedge_premises,
    hyperedge: effect.hyperedge,
    derivation: effect.derivation,
    derivations: effect.derivations,
    facet: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      path_id: composedFacetPathId(effect.hyperedge.to, effect.hyperedge.relation_kind),
      obligations: [{ obligation_id: createHash("sha256").update(`${effect.hyperedge.from.program_state}:${effect.hyperedge.to.program_state}`).digest("hex"),
        domain_id: ASSOCIATION_DOMAIN_ID }],
      coordinates: [effect.hyperedge.strength_milligrades]
    }
  };
}
