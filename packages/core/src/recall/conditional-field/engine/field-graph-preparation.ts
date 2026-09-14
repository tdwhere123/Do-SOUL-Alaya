import { extendMaxMinGraph, solveMaxMinField, MaxMinWorkQueue, PersistentStringMap,
  type MaxMinPreparedGraph } from "@do-soul/alaya-graph-algorithms";
import { canonicalProductIdentity, type ProductStateKey, type SeedActivation, type Transition } from "@do-soul/alaya-protocol";
import { hardIdentityCapContractId } from "../cap-contract.js";
import { RetainedSequence, type RetainedRows } from "./retained-sequence.js";

export type FieldGraphAdditions = Readonly<{ seeds: RetainedRows<SeedActivation>; transitions: RetainedRows<Transition> }>;
type PartitionNode = Readonly<{ product: string; contract: string; explicit: boolean }>;
type ProductGrade = Readonly<{ hard?: number; hardExplicit?: boolean; soft?: number; contract?: string; conflict?: boolean }>;
const HARD = hardIdentityCapContractId();

/** Persistent product projection; conflicting declared contracts never regain a scalar by arrival order. */
export class PreparedProductValues implements ReadonlyMap<string, number> {
  public constructor(private readonly rows = new PersistentStringMap<ProductGrade>(), public readonly size = 0,
    public readonly conflictCount = 0) {}
  public get [Symbol.toStringTag](): string { return "PreparedProductValues"; }
  public get(key: string): number | undefined {
    const row = this.rows.get(key);
    return row?.conflict ? undefined : row?.soft ?? row?.hard;
  }
  public has(key: string): boolean { return this.get(key) !== undefined; }
  public conflicted(key: string): boolean { return this.rows.get(key)?.conflict === true; }
  public contract(key: string): string | undefined {
    const row = this.rows.get(key);
    return row?.conflict ? undefined : row?.contract ?? (row?.hardExplicit ? HARD : undefined);
  }
  public with(node: PartitionNode, grade: number): PreparedProductValues {
    const prior = this.rows.get(node.product) ?? {};
    const next: ProductGrade = node.contract === HARD
      ? { ...prior, hard: Math.max(prior.hard ?? -1, grade), hardExplicit: prior.hardExplicit || node.explicit }
      : { ...prior, soft: prior.contract === node.contract ? Math.max(prior.soft ?? -1, grade) : grade,
          contract: node.contract, conflict: prior.conflict || prior.contract !== undefined && prior.contract !== node.contract };
    if (prior.hard === next.hard && prior.hardExplicit === next.hardExplicit && prior.soft === next.soft
      && prior.contract === next.contract && prior.conflict === next.conflict) return this;
    const exists = !next.conflict && (next.soft ?? next.hard) !== undefined;
    return new PreparedProductValues(this.rows.with(node.product, next), this.size + Number(exists) - Number(this.has(node.product)),
      this.conflictCount + Number(next.conflict === true) - Number(prior.conflict === true));
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
    graph: extendMaxMinGraph(undefined, [], []), keys: new PersistentStringMap(), nodes: new PersistentStringMap(),
    numericValues: new PersistentStringMap(), values: new PreparedProductValues(), queue: new MaxMinWorkQueue(),
    pending: RetainedSequence.empty(), allocatedPendingSlots: 0, admittedEdges: 0, retainedBytes: 0,
    seedOffset: 0, transitionOffset: 0, next: "prepare"
  };
  return incoming ? { ...state, deferred: additions } : state;
}

export function fieldGraphComplete(state: PreparedFieldGraph): boolean {
  return state.deferred === undefined && state.pending.length === 0 && state.queue.size === 0;
}

export type FieldGraphAtom = Readonly<{ seed?: SeedActivation; transition?: Transition; bytes: number }>;

/** Accounted retained representation, not a JavaScript RSS estimate. A cell is
 * 32 accounted bytes; AVL/heap path copies are bounded by twice log2(n+2),
 * including rotation/merge slack. Strings include worst-case nested JSON escaping.
 * Charges deliberately retain old versions while issued continuations may own them. */
export function nextFieldGraphAtom(state: PreparedFieldGraph, auxiliaryNodes = 0): FieldGraphAtom {
  let seed: SeedActivation | undefined;
  let transition: Transition | undefined;
  if ((state.pending.length > 0 || state.deferred !== undefined) && (state.next === "prepare" || state.queue.size === 0)) {
    const batch = state.pending.at(0) ?? state.deferred!;
    if (state.seedOffset < batch.seeds.length) seed = batch.seeds.at(state.seedOffset)!;
    else transition = batch.transitions.at(state.transitionOffset)!;
  }
  const encodedBytes = seed === undefined ? transition === undefined ? 0
    : escapedTextBytes(transition.from) + escapedTextBytes(transition.to) + (transition.cap_contract_id?.length ?? 0)
    : escapedTextBytes(seed.state) + (seed.cap_contract_id?.length ?? 0);
  const size = state.nodes.size + state.admittedEdges + state.queue.size + state.allocatedPendingSlots + auxiliaryNodes + 2;
  const depth = 2 * Math.ceil(Math.log2(size + 2)) + 4;
  const preparing = seed !== undefined || transition !== undefined;
  // Seed: three registration maps, numeric/product/cross values, queue and pending.
  // Edge: two registrations, outgoing list/map, queue and pending. Relax:
  // heap pop/two pushes and numeric/product/cross values. Strings are shared on relax.
  const updates = transition !== undefined ? 12 : seed !== undefined ? 9 : 7;
  const bytes = 1024 + 32 * depth * updates + (preparing ? 4 * encodedBytes : 0);
  return { seed, transition, bytes };
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
    const admitted = state.deferred === undefined ? current : { ...current, deferred: undefined,
      pending: state.pending.append(state.deferred), allocatedPendingSlots: state.allocatedPendingSlots + 1 };
    return { ...prepareRow(admitted, atom), retainedBytes: state.retainedBytes + atom.bytes, next: "relax" };
  }
  const result = solveMaxMinField({ nodeIds: [], seeds: new Map(), transitions: [], bottom: 0, top: 1000,
    preparedGraph: state.graph, priorValues: state.numericValues, workQueue: state.queue, workLimit: 1 });
  let values = state.values;
  let changedProduct: string | undefined;
  for (const [id, grade] of result.changedValues) {
    const node = state.nodes.get(id)!;
    values = values.with(node, grade);
    changedProduct = node.product;
  }
  return { ...state, numericValues: result.values, queue: result.workQueue, values,
    retainedBytes: state.retainedBytes + atom.bytes, changedProduct, next: "prepare" };
}

function prepareRow(state: PreparedFieldGraph, atom: FieldGraphAtom): PreparedFieldGraph {
  const batch = state.pending.at(0)!;
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
  const normalized = contract === undefined || contract.length === 0 ? HARD : contract;
  const id = JSON.stringify([normalized, product]);
  const prior = state.nodes.get(id);
  const node = { product, contract: normalized, explicit: prior?.explicit === true || contract !== undefined };
  return { id, node, state: { ...state, graph: extendMaxMinGraph(state.graph, [id], []),
    keys: state.keys.has(product) ? state.keys : state.keys.with(product, key), nodes: state.nodes.with(id, node) } };
}

function admitSeed(state: PreparedFieldGraph, seed: SeedActivation): PreparedFieldGraph {
  const registered = registerNode(state, seed.state, seed.cap_contract_id);
  const prior = registered.state.numericValues.get(registered.id);
  const grade = Math.max(prior ?? -1, seed.milligrades);
  const result = solveMaxMinField({ nodeIds: [], seeds: new Map([[registered.id, grade]]), transitions: [], bottom: 0, top: 1000,
    preparedGraph: registered.state.graph, priorValues: registered.state.numericValues, workQueue: registered.state.queue, workLimit: 0 });
  const normalizedGrade = result.values.get(registered.id)!;
  return { ...registered.state, numericValues: result.values,
    changedProduct: registered.node.product,
    values: registered.state.values.with(registered.node, normalizedGrade),
    queue: prior === normalizedGrade ? registered.state.queue : registered.state.queue.push({ nodeId: registered.id, strength: normalizedGrade }) };
}

function admitTransition(state: PreparedFieldGraph, edge: Transition): PreparedFieldGraph {
  // Inapplicable rows expose identities without bridging partitions or activating a product.
  const from = registerNode(state, edge.from, edge.cap_contract_id);
  const to = registerNode(from.state, edge.to, edge.cap_contract_id);
  if (!edge.applicable) return to.state;
  const offset = to.state.graph.edges.get(from.id)?.length ?? 0;
  const graph = extendMaxMinGraph(to.state.graph, [], [{ from: from.id, to: to.id, strength: edge.strength_milligrades }]);
  const grade = to.state.numericValues.get(from.id);
  return { ...to.state, graph, admittedEdges: state.admittedEdges + 1, queue: grade === undefined ? to.state.queue
    : to.state.queue.push({ nodeId: from.id, strength: grade, edgeOffset: offset }) };
}
