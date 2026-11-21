import { extendMaxMinGraph, solveMaxMinField, MaxMinWorkQueue, PersistentStringMap,
  type MaxMinPreparedGraph } from "@do-soul/alaya-graph-algorithms";
import { canonicalProductIdentity, type ProductStateKey, type SeedActivation, type Transition } from "@do-soul/alaya-protocol";
import { contractScalar, fieldPartitionNodeId, joinContractGrade,
  normalizeFieldPartitionContract, selectedCapCoordinate, type ContractGradeSummary } from "../cap-contract.js";
import { admitContractRow, advanceContractCoordinates, coordinateOf, emptyContractCoordinates, nextCoordinateRow,
  type ContractCoordinates } from "./contract-coordinates.js";
import { RetainedSequence, type RetainedRows } from "./retained-sequence.js";

export type FieldGraphAdditions = Readonly<{ seeds: RetainedRows<SeedActivation>; transitions: RetainedRows<Transition> }>;
type PartitionNode = Readonly<{ product: string; contract: string; explicit: boolean }>;
type ProductGrade = ContractGradeSummary;

/** Persistent product projection; conflicting declared contracts never regain a scalar by arrival order. */
class PreparedProductValues implements ReadonlyMap<string, number> {
  public constructor(private readonly rows = new PersistentStringMap<ProductGrade>(), public readonly size = 0,
    public readonly conflictCount = 0) {}
  public get [Symbol.toStringTag](): string { return "PreparedProductValues"; }
  public get(key: string): number | undefined {
    const row = this.rows.get(key);
    return row === undefined ? undefined : contractScalar(row);
  }
  public has(key: string): boolean { return this.get(key) !== undefined; }
  public conflicted(key: string): boolean {
    const row = this.rows.get(key);
    return row?.conflict === true && row.hard === undefined;
  }
  public summary(key: string): ContractGradeSummary { return this.rows.get(key) ?? {}; }
  public contract(key: string): string | undefined { return selectedCapCoordinate(this.summary(key)); }
  public with(node: PartitionNode, grade: number): PreparedProductValues {
    const prior = this.rows.get(node.product) ?? {};
    const next = joinContractGrade(prior, node.contract, grade);
    if (prior.hard === next.hard && prior.grade === next.grade
      && prior.coordinate === next.coordinate && prior.conflict === next.conflict) return this;
    const exists = contractScalar(next) !== undefined;
    return new PreparedProductValues(this.rows.with(node.product, next), this.size + Number(exists) - Number(this.has(node.product)),
      this.conflictCount + Number(next.conflict === true && next.hard === undefined)
        - Number(prior.conflict === true && prior.hard === undefined));
  }
  public *entries(): MapIterator<[string, number]> {
    for (const [key] of this.rows) { const value = this.get(key); if (value !== undefined) yield [key, value]; }
  }
  public *keys(): MapIterator<string> { for (const [key] of this) yield key; }
  public *values(): MapIterator<number> { for (const [, value] of this) yield value; }
  public [Symbol.iterator](): MapIterator<[string, number]> { return this.entries(); }
  public forEach(callback: (value: number, key: string, map: ReadonlyMap<string, number>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
}

export type PreparedFieldGraph = Readonly<{
  graph: MaxMinPreparedGraph;
  coordinates: ContractCoordinates;
  keys: PersistentStringMap<ProductStateKey>;
  nodes: PersistentStringMap<PartitionNode>;
  numericValues: ReadonlyMap<string, number>;
  values: PreparedProductValues;
  queue: MaxMinWorkQueue;
  pending: RetainedSequence<FieldGraphAdditions>;
  /** One bounded reference slot; indexed admission occurs only inside a funded atom. */
  deferred?: FieldGraphAdditions;
  allocatedPendingSlots: number;
  admittedEdges: number;
  retainedBytes: number;
  changedProduct?: string;
  seedOffset: number;
  transitionOffset: number;
  next: "prepare" | "relax";
}>;

/** Appending a delta retains its immutable rows; no source row is scanned before a charged step. */
export function appendFieldGraph(prior: PreparedFieldGraph | undefined, additions: FieldGraphAdditions,
  replacement: FieldGraphAdditions = additions): PreparedFieldGraph {
  const incoming = additions.seeds.length > 0 || additions.transitions.length > 0;
  // A second unadmitted delta cannot grow an unaccounted queue. The authoritative
  // retained rows are sufficient to rebuild; old roots remain charged to continuations.
  if (incoming && prior?.deferred !== undefined) return { ...appendFieldGraph(undefined, replacement), retainedBytes: prior.retainedBytes };
  const state: PreparedFieldGraph = prior ?? {
    graph: extendMaxMinGraph(undefined, [], []), coordinates: emptyContractCoordinates(),
    keys: new PersistentStringMap(), nodes: new PersistentStringMap(),
    numericValues: new PersistentStringMap(), values: new PreparedProductValues(), queue: new MaxMinWorkQueue(),
    pending: RetainedSequence.empty(), allocatedPendingSlots: 0, admittedEdges: 0, retainedBytes: 0,
    seedOffset: 0, transitionOffset: 0, next: "prepare"
  };
  return incoming ? { ...state, deferred: additions } : state;
}

export function fieldGraphComplete(state: PreparedFieldGraph): boolean {
  return state.deferred === undefined && state.pending.length === 0 && state.queue.size === 0
    && state.coordinates.pending === undefined;
}

export type FieldGraphAtom = Readonly<{ seed?: SeedActivation; transition?: Transition; coordinate?: string; bytes: number }>;

/** Accounted retained representation, not a JavaScript RSS estimate. A cell is
 * 32 accounted bytes; AVL/heap path copies are bounded by twice log2(n+2),
 * including rotation/merge slack. Strings include worst-case nested JSON escaping.
 * A request charges the live version; issued continuations keep prior retained bytes. */
export function nextFieldGraphAtom(state: PreparedFieldGraph, auxiliaryNodes = 0): FieldGraphAtom {
  let seed: SeedActivation | undefined;
  let transition: Transition | undefined;
  const lifted = nextCoordinateRow(state.coordinates);
  if (lifted !== undefined) { seed = lifted.seed; transition = lifted.transition; }
  else if ((state.pending.length > 0 || state.deferred !== undefined) && (state.next === "prepare" || state.queue.size === 0)) {
    const batch = state.pending.at(0) ?? state.deferred!;
    if (state.seedOffset < batch.seeds.length) seed = batch.seeds.at(state.seedOffset)!;
    else transition = batch.transitions.at(state.transitionOffset)!;
  }
  const encodedBytes = seed === undefined ? transition === undefined ? 0
    : escapedTextBytes(transition.from) + escapedTextBytes(transition.to) + (transition.cap_contract_id?.length ?? 0)
    : escapedTextBytes(seed.state) + (seed.cap_contract_id?.length ?? 0);
  const depth = treeDepth(state, auxiliaryNodes);
  const preparing = seed !== undefined || transition !== undefined;
  // Seed: three registration maps, numeric/product/cross values, queue and pending.
  // Edge: two registrations, outgoing list/map, queue and pending. Relax:
  // heap pop/two pushes and numeric/product/cross values. Strings are shared on relax.
  const updates = transition !== undefined ? 15 : seed !== undefined ? 12 : 7;
  const bytes = 1024 + 32 * depth * updates + (preparing ? 4 * encodedBytes : 0);
  return { seed, transition, coordinate: lifted?.coordinate, bytes };
}

function treeDepth(state: PreparedFieldGraph, auxiliaryNodes = 0): number {
  const size = state.nodes.size + state.admittedEdges + state.queue.size + state.allocatedPendingSlots
    + state.coordinates.coordinates.size + state.coordinates.hard.length + auxiliaryNodes + 2;
  return 2 * Math.ceil(Math.log2(size + 2)) + 4;
}

function transitionPartitionMetadataBytes(key: ProductStateKey): number {
  return key.program_state.length + key.hypothesis_id.length + key.time_state.length
    + (key.interpretation_node === undefined ? 0 : escapedTextBytes(key.interpretation_node));
}

function prepareRetainedDelta(state: PreparedFieldGraph, atom: FieldGraphAtom): number {
  const depth = treeDepth(state);
  const updates = atom.transition !== undefined ? 15 : 12;
  const coordinate = atom.coordinate ?? (atom.transition ?? atom.seed)!.cap_contract_id;
  // Seed states live in FieldEngineState already; charge only persistent tree
  // updates and newly retained coordinate / transition partition metadata.
  const partitionKeyBytes = atom.transition === undefined
    ? (coordinate?.length ?? 0)
    : (coordinate?.length ?? 0) + escapedTextBytes(atom.transition.relation_kind)
      + (atom.transition.instance_id?.length ?? 0)
      + transitionPartitionMetadataBytes(atom.transition.from)
      + transitionPartitionMetadataBytes(atom.transition.to);
  return 32 * depth * updates + 4 * partitionKeyBytes;
}

function escapedTextBytes(value: unknown): number {
  if (typeof value === "string") {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      bytes += code < 32 ? 12 : code === 34 || code === 92 ? 4 : code < 128 ? 1 : 3;
    }
    return bytes;
  }
  if (value === null || typeof value !== "object") return 0;
  let total = 0;
  for (const key in value) total += key.length + escapedTextBytes((value as Record<string, unknown>)[key]);
  return total;
}

/** One charged atom admits one row or relaxes one edge; contract partitions are disjoint numeric node namespaces. */
export function stepFieldGraph(state: PreparedFieldGraph, availableBytes: number, atom = nextFieldGraphAtom(state)): PreparedFieldGraph {
  if (fieldGraphComplete(state)) return state;
  if (atom.bytes > availableBytes) return state;
  if (atom.seed !== undefined || atom.transition !== undefined) {
    const current = { ...state, changedProduct: undefined };
    const prepareDelta = prepareRetainedDelta(state, atom);
    if (atom.coordinate !== undefined) {
      const expanded = { ...current, coordinates: advanceContractCoordinates(state.coordinates) };
      const prepared = atom.seed === undefined ? admitTransition(expanded, atom.transition!, atom.coordinate)
        : admitSeed(expanded, atom.seed, atom.coordinate);
      return { ...prepared, retainedBytes: state.retainedBytes + prepareDelta, next: "relax" };
    }
    const admitted = state.deferred === undefined ? current : { ...current, deferred: undefined,
      pending: state.pending.append(state.deferred), allocatedPendingSlots: state.allocatedPendingSlots + 1 };
    return { ...prepareRow(admitted, atom), retainedBytes: state.retainedBytes + prepareDelta, next: "relax" };
  }
  const depth = treeDepth(state);
  const result = solveMaxMinField({ nodeIds: [], seeds: new Map(), transitions: [], bottom: 0, top: 1000,
    preparedGraph: state.graph, priorValues: state.numericValues, workQueue: state.queue, workLimit: 1 });
  let values = state.values;
  let changedProduct: string | undefined;
  for (const [id, grade] of result.changedValues) {
    const node = state.nodes.get(id)!;
    values = values.with(node, grade);
    changedProduct = node.product;
  }
  const relaxDelta = result.changedValues.size === 0 ? 0 : 32 * depth * 3 * result.changedValues.size;
  return { ...state, numericValues: result.values, queue: result.workQueue, values,
    retainedBytes: state.retainedBytes + relaxDelta, changedProduct, next: "prepare" };
}

function prepareRow(state: PreparedFieldGraph, atom: FieldGraphAtom): PreparedFieldGraph {
  const batch = state.pending.at(0)!;
  const row = atom.seed === undefined ? { transition: atom.transition! } : { seed: atom.seed };
  state = { ...state, coordinates: admitContractRow(state.coordinates, row) };
  let next: PreparedFieldGraph;
  if (state.seedOffset < batch.seeds.length) {
    next = { ...admitSeed(state, atom.seed!), seedOffset: state.seedOffset + 1 };
  } else {
    next = { ...admitTransition(state, atom.transition!), transitionOffset: state.transitionOffset + 1 };
  }
  return next.seedOffset === batch.seeds.length && next.transitionOffset === batch.transitions.length
    ? { ...next, pending: next.pending.length === 1 ? RetainedSequence.empty() : next.pending.slice(1),
        seedOffset: 0, transitionOffset: 0 } : next;
}

function registerNode(state: PreparedFieldGraph, key: ProductStateKey, contract: string | undefined): {
  readonly state: PreparedFieldGraph; readonly id: string; readonly node: PartitionNode;
} {
  const product = canonicalProductIdentity(key);
  const normalized = normalizeFieldPartitionContract(contract);
  const id = fieldPartitionNodeId(product, contract);
  const prior = state.nodes.get(id);
  const node = { product, contract: normalized, explicit: prior?.explicit === true || contract !== undefined };
  return { id, node, state: { ...state, graph: extendMaxMinGraph(state.graph, [id], []),
    keys: state.keys.has(product) ? state.keys : state.keys.with(product, key), nodes: state.nodes.with(id, node) } };
}

function admitSeed(state: PreparedFieldGraph, seed: SeedActivation, coordinate = coordinateOf({ seed })): PreparedFieldGraph {
  const registered = registerNode(state, seed.state, coordinate);
  const prior = registered.state.numericValues.get(registered.id);
  const grade = Math.max(prior ?? -1, seed.milligrades);
  const result = solveMaxMinField({ nodeIds: [], seeds: new Map([[registered.id, grade]]), transitions: [], bottom: 0, top: 1000,
    preparedGraph: registered.state.graph, priorValues: registered.state.numericValues, workQueue: registered.state.queue, workLimit: 0 });
  const normalizedGrade = result.values.get(registered.id)!;
  return { ...registered.state, numericValues: result.values,
    changedProduct: registered.node.product,
    values: registered.state.values.with(registered.node, normalizedGrade),
    queue: result.workQueue };
}

function admitTransition(state: PreparedFieldGraph, edge: Transition, coordinate = coordinateOf({ transition: edge })): PreparedFieldGraph {
  // Inapplicable rows expose identities without bridging partitions or activating a product.
  const from = registerNode(state, edge.from, coordinate);
  const to = registerNode(from.state, edge.to, coordinate);
  if (!edge.applicable) return to.state;
  const offset = to.state.graph.edges.get(from.id)?.length ?? 0;
  const graph = extendMaxMinGraph(to.state.graph, [], [{ from: from.id, to: to.id, strength: edge.strength_milligrades }]);
  const grade = to.state.numericValues.get(from.id);
  return { ...to.state, graph, admittedEdges: state.admittedEdges + 1, queue: grade === undefined ? to.state.queue
    : to.state.queue.push({ nodeId: from.id, strength: grade, edgeOffset: offset }) };
}
