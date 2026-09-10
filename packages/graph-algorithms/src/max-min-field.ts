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
}

export class MaxMinOutgoingEdges {
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
  for (const id of nodeIds) nodes = nodes.with(id, true);
  for (const edge of transitions) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    edges = edges.with(edge.from, (edges.get(edge.from) ?? new MaxMinOutgoingEdges()).append(edge));
  }
  return { nodeIds: nodes, edges };
}

export interface MaxMinResult {
  readonly values: ReadonlyMap<string, number>;
  readonly retainedTransitions: readonly MaxMinTransition[];
  readonly remainingWorklist: readonly MaxMinWorkItem[];
  readonly steps: number;
  readonly complete: boolean;
  readonly workQueue: MaxMinWorkQueue;
}

export function solveMaxMinField(input: MaxMinInput): MaxMinResult {
  const top = requireIntegerTop(input.top, input.bottom);
  const nodeIds = input.preparedGraph === undefined ? uniqueNodeIds(input.nodeIds) : [];
  const values = initialValues(input.preparedGraph?.nodeIds ?? new Set(nodeIds), input.seeds, input.bottom, top, input.priorValues);
  const retainedTransitions = input.preparedGraph === undefined
    ? legalTransitions(nodeIds, input.transitions, input.bottom, top) : input.transitions;
  const relaxed = relaxMaxMin(
    values,
    input.preparedGraph?.edges ?? adjacency(retainedTransitions),
    input.worklist,
    input.workLimit,
    input.workQueue
  );
  return {
    values: relaxed.values,
    retainedTransitions,
    get remainingWorklist() { return [...relaxed.workQueue]; },
    workQueue: relaxed.workQueue,
    steps: relaxed.steps,
    complete: relaxed.complete
  };
}

function requireIntegerTop(top: number, bottom: 0): number {
  if (bottom !== 0 || !Number.isInteger(top) || top < 0) {
    throw new Error("max-min top must be a nonnegative integer with bottom 0");
  }
  return top;
}

function uniqueNodeIds(nodeIds: readonly string[]): readonly string[] {
  return [...new Set(nodeIds)];
}

function clampInteger(value: number, bottom: number, top: number): number {
  if (!Number.isFinite(value)) return bottom;
  const integer = Math.trunc(value);
  if (integer < bottom) return bottom;
  if (integer > top) return top;
  return integer;
}

function initialValues(
  nodeIds: Readonly<{ has(key: string): boolean }>,
  seeds: ReadonlyMap<string, number>,
  bottom: 0,
  top: number,
  priorValues: ReadonlyMap<string, number> | undefined
): PersistentStringMap<number> {
  let values = priorValues instanceof PersistentStringMap ? priorValues : new PersistentStringMap<number>();
  for (const [nodeId, value] of priorValues instanceof PersistentStringMap ? [] : priorValues ?? []) {
    if (!nodeIds.has(nodeId)) continue;
    const clamped = clampInteger(value, bottom, top);
    const current = values.get(nodeId);
    if (current === undefined || clamped > current) values = values.with(nodeId, clamped);
  }
  for (const [nodeId, value] of seeds) {
    if (!nodeIds.has(nodeId)) continue;
    const grade = clampInteger(value, bottom, top);
    if (!values.has(nodeId) || grade > values.get(nodeId)!) values = values.with(nodeId, grade);
  }
  return values;
}

function legalTransitions(
  nodeIds: readonly string[],
  transitions: readonly MaxMinTransition[],
  bottom: 0,
  top: number
): readonly MaxMinTransition[] {
  const nodeSet = new Set(nodeIds);
  const legal: MaxMinTransition[] = [];
  for (const transition of transitions) {
    if (!nodeSet.has(transition.from) || !nodeSet.has(transition.to)) continue;
    legal.push({
      from: transition.from,
      to: transition.to,
      strength: clampInteger(transition.strength, bottom, top)
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

function relaxMaxMin(
  priorValues: PersistentStringMap<number>,
  edges: ReadonlyMap<string, MaxMinOutgoingEdges>,
  worklist: readonly MaxMinWorkItem[] | undefined,
  workLimit: number | undefined,
  retainedQueue: MaxMinWorkQueue | undefined
): { values: PersistentStringMap<number>; workQueue: MaxMinWorkQueue; steps: number; complete: boolean } {
  let values = priorValues;
  let heap = retainedQueue ?? new MaxMinWorkQueue();
  if (worklist !== undefined) {
    for (const item of worklist) heap = heap.push(item);
  } else if (retainedQueue === undefined) {
    for (const [nodeId, value] of values) heap = heap.push({ strength: value, nodeId });
  }
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
      heap = heap.push({ strength: next, nodeId: transition.to });
    }
  }
  return { values, workQueue: heap, steps, complete: true };
}
