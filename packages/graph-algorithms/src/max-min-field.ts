export interface MaxMinTransition {
  readonly from: string;
  readonly to: string;
  readonly strength: number;
}

export interface MaxMinInput {
  readonly nodeIds: readonly string[];
  readonly seeds: ReadonlyMap<string, number>;
  readonly transitions: readonly MaxMinTransition[];
  readonly bottom: 0;
  readonly top: number;
}

export interface MaxMinResult {
  readonly values: ReadonlyMap<string, number>;
  readonly retainedTransitions: readonly MaxMinTransition[];
}

export function solveMaxMinField(input: MaxMinInput): MaxMinResult {
  const top = requireIntegerTop(input.top, input.bottom);
  const nodeIds = uniqueNodeIds(input.nodeIds);
  const values = initialValues(nodeIds, input.seeds, input.bottom, top);
  const retainedTransitions = legalTransitions(nodeIds, input.transitions, input.bottom, top);
  relaxMaxMin(values, adjacency(retainedTransitions), input.bottom);
  return { values, retainedTransitions };
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
  nodeIds: readonly string[],
  seeds: ReadonlyMap<string, number>,
  bottom: 0,
  top: number
): Map<string, number> {
  const values = new Map<string, number>();
  for (const nodeId of nodeIds) {
    values.set(nodeId, clampInteger(seeds.get(nodeId) ?? bottom, bottom, top));
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
): ReadonlyMap<string, readonly MaxMinTransition[]> {
  const edges = new Map<string, MaxMinTransition[]>();
  for (const transition of transitions) {
    const outgoing = edges.get(transition.from);
    if (outgoing === undefined) edges.set(transition.from, [transition]);
    else outgoing.push(transition);
  }
  return edges;
}

function relaxMaxMin(
  values: Map<string, number>,
  edges: ReadonlyMap<string, readonly MaxMinTransition[]>,
  bottom: 0
): void {
  const heap = new MaxHeap();
  for (const [nodeId, value] of values) {
    if (value > bottom) heap.push(value, nodeId);
  }
  while (!heap.isEmpty()) {
    const current = heap.pop();
    if (current.strength !== values.get(current.nodeId)) continue;
    for (const transition of edges.get(current.nodeId) ?? []) {
      const next = Math.min(current.strength, transition.strength);
      const prior = values.get(transition.to) ?? bottom;
      if (next > prior) {
        values.set(transition.to, next);
        heap.push(next, transition.to);
      }
    }
  }
}

class MaxHeap {
  private readonly items: Array<{ strength: number; nodeId: string }> = [];

  public push(strength: number, nodeId: string): void {
    this.items.push({ strength, nodeId });
    this.siftUp(this.items.length - 1);
  }

  public pop(): { strength: number; nodeId: string } {
    const first = this.items[0];
    const last = this.items.pop();
    if (first === undefined || last === undefined) {
      throw new Error("max-min heap underflow");
    }
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return first;
  }

  public isEmpty(): boolean {
    return this.items.length === 0;
  }

  private siftUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.items[parent]!.strength >= this.items[current]!.strength) return;
      this.swap(parent, current);
      current = parent;
    }
  }

  private siftDown(index: number): void {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let best = current;
      if (left < this.items.length && this.items[left]!.strength > this.items[best]!.strength) {
        best = left;
      }
      if (right < this.items.length && this.items[right]!.strength > this.items[best]!.strength) {
        best = right;
      }
      if (best === current) return;
      this.swap(current, best);
      current = best;
    }
  }

  private swap(left: number, right: number): void {
    const stored = this.items[left]!;
    this.items[left] = this.items[right]!;
    this.items[right] = stored;
  }
}
