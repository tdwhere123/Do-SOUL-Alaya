import type { Derivation, SeedActivation, Transition } from "@do-soul/alaya-protocol";
import { productStateNodeId } from "../reference/bind-max-min.js";
import { transitionKey } from "./path-composition.js";
import { joinDerivation, leafDerivation } from "./path-derivation.js";
import type { BoundSourceFacts } from "./binding-environment.js";

type GroundTask = { readonly key: string; readonly root: string; readonly visited: readonly string[]; readonly offset: number }
  | { readonly key: string; readonly root: string; readonly visited: readonly string[]; readonly edge: string; readonly child: number };

export type GroundingProgress = Readonly<{
  readonly counts: string;
  readonly completed_work: number;
  readonly retained_bytes: number;
  readonly forest: ReadonlyMap<string, Derivation>;
  readonly outgoing: ReadonlyMap<string, readonly Transition[]>;
  readonly roots: Readonly<Record<string, readonly string[]>>;
  readonly derivation_offset: number;
  readonly transition_offset: number;
  readonly seed_offset: number;
  readonly tasks: readonly GroundTask[];
}>;

export function groundedOutputDerivations(input: {
  readonly seeds: readonly SeedActivation[];
  readonly transitions: readonly Transition[];
  readonly derivations: readonly Derivation[];
  readonly transition_derivations: Readonly<Record<string, string>>;
  readonly allowance: number;
  readonly memory_bytes?: number;
  readonly progress?: GroundingProgress;
  readonly source_facts?: Readonly<Record<string, BoundSourceFacts>>;
}): { derivations: readonly Derivation[]; roots: Readonly<Record<string, readonly string[]>>; work: number;
  retained_bytes: number; complete: boolean; progress: GroundingProgress } {
  const counts = `${input.seeds.length}:${input.transitions.length}:${input.derivations.length}`;
  const prior = input.progress?.counts === counts ? input.progress : undefined;
  const forest = new Map(prior?.forest);
  const outgoing = new Map(prior?.outgoing);
  const roots = { ...prior?.roots };
  const tasks = [...prior?.tasks ?? []];
  let derivationOffset = prior?.derivation_offset ?? 0;
  let transitionOffset = prior?.transition_offset ?? 0;
  let seedOffset = prior?.seed_offset ?? 0;
  let work = 0;
  let retainedBytes = 0;
  const releasedPrior = prior === undefined ? input.progress?.retained_bytes ?? 0 : 0;
  const retain = (bytes: number): boolean => {
    if (retainedBytes + bytes > (input.memory_bytes ?? Number.MAX_SAFE_INTEGER) + releasedPrior) return false;
    retainedBytes += bytes;
    return true;
  };
  while (work < input.allowance) {
    if (derivationOffset < input.derivations.length) {
      const node = input.derivations[derivationOffset]!;
      if (!retain(64 + node.derivation_id.length * 2)) break;
      forest.set(node.derivation_id, node);
      derivationOffset += 1;
    } else if (transitionOffset < input.transitions.length) {
      const edge = input.transitions[transitionOffset]!;
      if (!retain(64)) break;
      if (edge.applicable) {
        const key = productStateNodeId(edge.from);
        outgoing.set(key, [...outgoing.get(key) ?? [], edge]);
      }
      transitionOffset += 1;
    } else if (seedOffset < input.seeds.length) {
      const seed = input.seeds[seedOffset]!;
      const key = productStateNodeId(seed.state);
      const root = leafDerivation({ derivation_id: `seed:${key}`, observation_id: seed.state.object_id,
        source_revision: input.source_facts?.[seed.state.object_id]?.source_revision, association_milligrades: seed.milligrades });
      const task: GroundTask = { key, root: root.derivation_id, visited: [], offset: 0 };
      if (!retain(bytesFor([root, task]))) break;
      forest.set(root.derivation_id, root);
      tasks.push(task);
      seedOffset += 1;
    } else {
      const task = tasks[0];
      if (task === undefined) break;
      if (!advanceGroundTask(task, { forest, outgoing, roots, tasks, transitionRoots: input.transition_derivations, retain,
        release: (bytes) => { retainedBytes -= bytes; } })) break;
    }
    work += 1;
  }
  const progress: GroundingProgress = { counts, forest, outgoing, roots, tasks, completed_work: (prior?.completed_work ?? 0) + work,
    retained_bytes: (prior?.retained_bytes ?? 0) + retainedBytes,
    derivation_offset: derivationOffset, transition_offset: transitionOffset, seed_offset: seedOffset };
  return { derivations: [...forest.values()], roots, work, retained_bytes: retainedBytes - releasedPrior, progress,
    complete: derivationOffset === input.derivations.length && transitionOffset === input.transitions.length
      && seedOffset === input.seeds.length && tasks.length === 0 };
}

function advanceGroundTask(task: GroundTask, state: {
  forest: Map<string, Derivation>; outgoing: Map<string, readonly Transition[]>; roots: Record<string, readonly string[]>;
  tasks: GroundTask[]; transitionRoots: Readonly<Record<string, string>>; retain: (bytes: number) => boolean;
  release: (bytes: number) => void;
}): boolean {
  const remove = (): void => { state.tasks.shift(); state.release(bytesFor(task)); };
  if ("edge" in task) {
    const edge = state.forest.get(task.edge);
    const parent = state.forest.get(task.root);
    if (edge === undefined || parent === undefined) { remove(); return true; }
    if (edge.kind === "or") {
      const child = edge.children[task.child];
      if (child === undefined) { remove(); return true; }
      const next = { ...task, edge: child, child: 0 };
      if (!state.retain(bytesFor(next))) return false;
      state.tasks[0] = { ...task, child: task.child + 1 };
      state.tasks.push(next);
      return true;
    }
    const root = joinDerivation("serial", [parent, edge]);
    const next = { key: task.key, root: root.derivation_id, visited: task.visited, offset: 0 };
    if (!state.retain(bytesFor(next) + (state.forest.has(root.derivation_id) ? 0 : bytesFor(root)))) return false;
    state.forest.set(root.derivation_id, root);
    remove();
    state.tasks.push(next);
    return true;
  }
  if (task.visited.includes(task.key)) { remove(); return true; }
  if (task.offset === 0) {
    const ids = state.roots[task.key] ?? [];
    if (!ids.includes(task.root)) {
      if (!state.retain(bytesFor([task.key, task.root]))) return false;
      state.roots[task.key] = [...ids, task.root];
    }
  }
  const transition = state.outgoing.get(task.key)?.[task.offset];
  if (transition === undefined) { remove(); return true; }
  const edge = state.transitionRoots[transitionKey(transition)];
  if (edge !== undefined) {
    const next = { key: productStateNodeId(transition.to), root: task.root, visited: [...task.visited, task.key], edge, child: 0 };
    if (!state.retain(bytesFor(next))) return false;
    state.tasks.push(next);
  }
  state.tasks[0] = { ...task, offset: task.offset + 1 };
  return true;
}

function bytesFor(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
