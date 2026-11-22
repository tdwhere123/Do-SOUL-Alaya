import { requireGrade } from "./bottleneck-hypergraph.js";
import { PersistentStringMap } from "./persistent-string-map.js";
import { MaxMinWorkQueue } from "./max-min-work-queue.js";

export interface MaxMinTransition {
  readonly from: string;
  readonly to: string;
  readonly strength: number;
}

export interface MaxMinWorkItem {
  readonly nodeId: string;
  readonly strength: number;
  readonly edgeOffset?: number;
}

export interface MaxMinInput {
  readonly nodeIds: readonly string[];
  readonly seeds: ReadonlyMap<string, number>;
  readonly transitions: readonly MaxMinTransition[];
  readonly bottom: 0;
  readonly top: number;
  readonly priorValues?: ReadonlyMap<string, number>;
  readonly worklist?: readonly MaxMinWorkItem[];
  readonly workLimit?: number;
  readonly preparedGraph?: MaxMinPreparedGraph;
  readonly workQueue?: MaxMinWorkQueue;
}

export interface MaxMinPreparedGraph {
  readonly nodeIds: PersistentStringMap<true>;
  readonly edges: PersistentStringMap<MaxMinOutgoingEdges>;
  readonly maxStrength: number;
}

class MaxMinOutgoingEdges {
  public constructor(public readonly length = 0, private readonly items = new PersistentStringMap<MaxMinTransition>()) {}
  public at(offset: number): MaxMinTransition | undefined { return this.items.get(String(offset)); }
  public append(edge: MaxMinTransition): MaxMinOutgoingEdges {
    return new MaxMinOutgoingEdges(this.length + 1, this.items.with(String(this.length), edge));
  }
}

export function extendMaxMinGraph(prior: MaxMinPreparedGraph | undefined,
  nodeIds: readonly string[], transitions: readonly MaxMinTransition[]): MaxMinPreparedGraph {
  let nodes = prior?.nodeIds ?? new PersistentStringMap<true>();
  let edges = prior?.edges ?? new PersistentStringMap<MaxMinOutgoingEdges>();
  let maxStrength = prior?.maxStrength ?? 0;
  for (const id of nodeIds) nodes = nodes.with(id, true);
  for (const edge of transitions) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const strength = requireGrade(edge.strength, Number.MAX_SAFE_INTEGER);
    maxStrength = Math.max(maxStrength, edge.strength);
    edges = edges.with(edge.from, (edges.get(edge.from) ?? new MaxMinOutgoingEdges()).append({ ...edge, strength }));
  }
  return { nodeIds: nodes, edges, maxStrength };
}

export interface MaxMinResult {
  readonly values: ReadonlyMap<string, number>;
  /** Only coordinates changed by this invocation, for bounded downstream projection. */
  readonly changedValues: ReadonlyMap<string, number>;
  readonly retainedTransitions: readonly MaxMinTransition[];
  readonly remainingWorklist: readonly MaxMinWorkItem[];
  readonly steps: number;
  readonly complete: boolean;
  readonly workQueue: MaxMinWorkQueue;
}

export function solveMaxMinField(input: MaxMinInput): MaxMinResult {
  const changedValues = new Map<string, number>();
  const top = input.top;
  if (input.bottom !== 0 || !Number.isSafeInteger(top) || top < 0) {
    throw new Error("max-min top must be a safe nonnegative integer with bottom 0");
  }
  if (input.preparedGraph !== undefined) requireGrade(input.preparedGraph.maxStrength, top);
  const nodeIds = input.preparedGraph === undefined ? uniqueNodeIds(input.nodeIds) : [];
  const values = initialValues(input.preparedGraph?.nodeIds ?? new Set(nodeIds), input.seeds, top, input.priorValues, changedValues);
  const retainedTransitions = input.preparedGraph === undefined
    ? legalTransitions(nodeIds, input.transitions, top) : input.transitions;
  const workQueue = initialQueue(values, changedValues, top, input.workQueue, input.worklist);
  const relaxed = relaxMaxMin(
    values,
    input.preparedGraph?.edges ?? adjacency(retainedTransitions),
    input.workLimit,
    workQueue,
    changedValues
  );
  return {
    values: bindTrustedTop(relaxed.values, top),
    changedValues,
    retainedTransitions,
    get remainingWorklist() { return [...relaxed.workQueue]; },
    workQueue: relaxed.workQueue,
    steps: relaxed.steps,
    complete: relaxed.complete
  };
}

function uniqueNodeIds(nodeIds: readonly string[]): readonly string[] {
  return [...new Set(nodeIds)];
}

function trustedTop(values: PersistentStringMap<number>): number | undefined {
  const bound = (values as PersistentStringMap<number> & { readonly top?: unknown }).top;
  return typeof bound === "number" && Number.isSafeInteger(bound) ? bound : undefined;
}

function bindTrustedTop(values: PersistentStringMap<number>, top: number): PersistentStringMap<number> {
  if (trustedTop(values) === top) return values;
  Object.defineProperty(values, "top", { value: top, configurable: true, enumerable: false, writable: false });
  return values;
}

function initialValues(
  nodeIds: Readonly<{ has(key: string): boolean }>,
  seeds: ReadonlyMap<string, number>,
  top: number,
  priorValues: ReadonlyMap<string, number> | undefined,
  changedValues: Map<string, number>
): PersistentStringMap<number> {
  const bound = priorValues instanceof PersistentStringMap ? trustedTop(priorValues) : undefined;
  if (bound !== undefined && bound !== top) {
    throw new RangeError(`max-min trusted state top ${bound} disagrees with ${top}`);
  }
  const reuse = priorValues instanceof PersistentStringMap && bound === top;
  let values = reuse ? priorValues : new PersistentStringMap<number>();
  for (const [nodeId, value] of reuse ? [] : priorValues ?? []) {
    if (!nodeIds.has(nodeId)) continue;
    const grade = requireGrade(value, top);
    const current = values.get(nodeId);
    if (current === undefined || grade > current) values = values.with(nodeId, grade);
  }
  for (const [nodeId, value] of seeds) {
    if (!nodeIds.has(nodeId)) continue;
    const grade = requireGrade(value, top);
    if (!values.has(nodeId) || grade > values.get(nodeId)!) {
      values = values.with(nodeId, grade);
      changedValues.set(nodeId, grade);
    }
  }
  return values;
}

function legalTransitions(
  nodeIds: readonly string[],
  transitions: readonly MaxMinTransition[],
  top: number
): readonly MaxMinTransition[] {
  const nodeSet = new Set(nodeIds);
  const legal: MaxMinTransition[] = [];
  for (const transition of transitions) {
    if (!nodeSet.has(transition.from) || !nodeSet.has(transition.to)) continue;
    legal.push({
      from: transition.from,
      to: transition.to,
      strength: requireGrade(transition.strength, top)
    });
  }
  return legal;
}

function adjacency(
  transitions: readonly MaxMinTransition[]
): ReadonlyMap<string, MaxMinOutgoingEdges> {
  const edges = new Map<string, MaxMinOutgoingEdges>();
  for (const transition of transitions) {
    edges.set(transition.from, (edges.get(transition.from) ?? new MaxMinOutgoingEdges()).append(transition));
  }
  return edges;
}

function initialQueue(values: ReadonlyMap<string, number>, raisedSeeds: ReadonlyMap<string, number>, top: number,
  retainedQueue: MaxMinWorkQueue | undefined, worklist: readonly MaxMinWorkItem[] | undefined): MaxMinWorkQueue {
  let queue = retainedQueue ?? new MaxMinWorkQueue();
  for (const item of worklist ?? []) queue = queue.push({ ...item, strength: requireGrade(item.strength, top) });
  const pendingSeeds = retainedQueue === undefined && worklist === undefined ? values : raisedSeeds;
  for (const [nodeId, strength] of pendingSeeds) queue = queue.push({ nodeId, strength });
  return queue;
}

function relaxMaxMin(
  priorValues: PersistentStringMap<number>,
  edges: ReadonlyMap<string, MaxMinOutgoingEdges>,
  workLimit: number | undefined,
  heap: MaxMinWorkQueue,
  changedValues: Map<string, number>
): { values: PersistentStringMap<number>; workQueue: MaxMinWorkQueue; steps: number; complete: boolean } {
  let values = priorValues;
  let steps = 0;
  while (heap.size > 0) {
    if (workLimit !== undefined && steps >= workLimit) {
      return { values, workQueue: heap, steps, complete: false };
    }
    const popped = heap.pop()!;
    const current = popped.item;
    heap = popped.queue;
    if (current.strength !== values.get(current.nodeId)) { steps += 1; continue; }
    const outgoing = edges.get(current.nodeId);
    const offset = current.edgeOffset ?? 0;
    const transition = outgoing?.at(offset);
    steps += 1;
    if (transition !== undefined) {
      if (offset + 1 < outgoing!.length) heap = heap.push({ ...current, edgeOffset: offset + 1 });
      const next = Math.min(current.strength, transition.strength);
      const prior = values.get(transition.to);
      if (prior !== undefined && next <= prior) continue;
      values = values.with(transition.to, next);
      changedValues.set(transition.to, next);
      heap = heap.push({ strength: next, nodeId: transition.to });
    }
  }
  return { values, workQueue: heap, steps, complete: true };
}
