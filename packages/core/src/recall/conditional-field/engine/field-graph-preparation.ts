import { extendMaxMinGraph, MaxMinWorkQueue, PersistentStringMap, type MaxMinPreparedGraph } from "@do-soul/alaya-graph-algorithms";
import { canonicalProductIdentity, type ProductStateKey, type SeedActivation, type Transition } from "@do-soul/alaya-protocol";
import type { RetainedRows } from "./retained-sequence.js";

export type FieldGraphAdditions = Readonly<{ seeds: RetainedRows<SeedActivation>; transitions: RetainedRows<Transition> }>;
type PendingBatch = FieldGraphAdditions & Readonly<{ seedOffset: number; transitionOffset: number }>;

export type PreparedFieldGraph = Readonly<{
  graph: MaxMinPreparedGraph;
  keys: PersistentStringMap<ProductStateKey>;
  seedGrades: PersistentStringMap<number>;
  pending: readonly PendingBatch[];
}>;

/** Preparation shares the previous index and charges each newly admitted source row before inspecting it. */
export function prepareFieldGraph(input: Readonly<{
  prior?: PreparedFieldGraph;
  additions: FieldGraphAdditions;
  priorValues?: ReadonlyMap<string, number>;
  workQueue?: MaxMinWorkQueue;
  workLimit: number;
}>): Readonly<{ preparation: PreparedFieldGraph; seedChanges: ReadonlyMap<string, number>; queue: MaxMinWorkQueue; steps: number; complete: boolean }> {
  let graph = input.prior?.graph ?? extendMaxMinGraph(undefined, [], []);
  let keys = input.prior?.keys ?? new PersistentStringMap<ProductStateKey>();
  let seedGrades = input.prior?.seedGrades ?? new PersistentStringMap<number>();
  const pending = [...input.prior?.pending ?? []];
  if (input.additions.seeds.length > 0 || input.additions.transitions.length > 0) pending.push({ ...input.additions, seedOffset: 0, transitionOffset: 0 });
  let queue = input.workQueue ?? new MaxMinWorkQueue();
  const seedChanges = new Map<string, number>();
  let steps = 0;
  while (pending.length > 0 && steps < input.workLimit) {
    const batch = pending[0]!;
    if (batch.seedOffset < batch.seeds.length) {
      steps += 1;
      const seed = batch.seeds.at(batch.seedOffset)!;
      const key = canonicalProductIdentity(seed.state);
      if (!keys.has(key)) keys = keys.with(key, seed.state);
      graph = extendMaxMinGraph(graph, [key], []);
      const grade = Math.max(seedGrades.get(key) ?? -1, seed.milligrades);
      if (seedGrades.get(key) !== grade) {
        seedGrades = seedGrades.with(key, grade);
        seedChanges.set(key, grade);
        queue = queue.push({ nodeId: key, strength: Math.max(grade, input.priorValues?.get(key) ?? grade) });
      }
      pending[0] = { ...batch, seedOffset: batch.seedOffset + 1 };
    } else if (batch.transitionOffset < batch.transitions.length) {
      steps += 1;
      const edge = batch.transitions.at(batch.transitionOffset)!;
      const from = canonicalProductIdentity(edge.from);
      const to = canonicalProductIdentity(edge.to);
      if (!keys.has(from)) keys = keys.with(from, edge.from);
      if (!keys.has(to)) keys = keys.with(to, edge.to);
      const edgeOffset = graph.edges.get(from)?.length ?? 0;
      graph = extendMaxMinGraph(graph, [from, to], edge.applicable ? [{ from, to, strength: edge.strength_milligrades }] : []);
      const grade = Math.max(input.priorValues?.get(from) ?? -1, seedGrades.get(from) ?? -1);
      if (edge.applicable && grade >= 0) queue = queue.push({ nodeId: from, strength: grade, edgeOffset });
      pending[0] = { ...batch, transitionOffset: batch.transitionOffset + 1 };
    } else pending.shift();
  }
  while (pending[0] !== undefined && pending[0].seedOffset === pending[0].seeds.length
    && pending[0].transitionOffset === pending[0].transitions.length) pending.shift();
  return { preparation: { graph, keys, seedGrades, pending }, seedChanges, queue, steps, complete: pending.length === 0 };
}
