import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import type { Derivation } from "@do-soul/alaya-protocol";

type Visit = Readonly<{ id: string; next: Visit | null; node?: Derivation; childOffset?: number }>;
export type DerivationTraversal = Readonly<{
  pending: Visit | null;
  root_offset: number;
  marks: PersistentStringMap<"active" | "done">;
  nodes: PersistentStringMap<Derivation>;
  leaves: PersistentStringMap<Derivation>;
  postorder: PersistentStringMap<Derivation>;
  invalid: boolean;
}>;

/** Local leaf receipts are the provenance owner; ancestor summaries are never evidence. */
export function traceDerivationForest(input: Readonly<{
  forest: Readonly<{ get(id: string): Derivation | undefined }>;
  roots: Readonly<{ length: number; at(index: number): string | undefined }>;
  maxVisits?: number;
  progress?: DerivationTraversal;
}>): Readonly<{ traversal: DerivationTraversal; work: number; complete: boolean }> {
  let pending = input.progress?.pending ?? null;
  let rootOffset = input.progress?.root_offset ?? 0;
  let marks = input.progress?.marks ?? new PersistentStringMap<"active" | "done">();
  let nodes = input.progress?.nodes ?? new PersistentStringMap<Derivation>();
  let leaves = input.progress?.leaves ?? new PersistentStringMap<Derivation>();
  let postorder = input.progress?.postorder ?? new PersistentStringMap<Derivation>();
  let invalid = input.progress?.invalid ?? false;
  let work = 0;
  while ((pending !== null || rootOffset < input.roots.length) && work < (input.maxVisits ?? Number.MAX_SAFE_INTEGER)) {
    if (pending === null) pending = { id: input.roots.at(rootOffset++)!, next: null };
    const visit: Visit = pending;
    pending = visit.next;
    work += 1;
    if (visit.node === undefined) {
      const status = marks.get(visit.id);
      if (status === "done") continue;
      if (status === "active") { invalid = true; continue; }
      const node = input.forest.get(visit.id);
      if (node === undefined) { invalid = true; continue; }
      marks = marks.with(visit.id, "active");
      nodes = nodes.with(visit.id, node);
      if (node.kind === "leaf") leaves = leaves.with(visit.id, node);
      pending = { id: visit.id, node, childOffset: 0, next: pending };
    } else if ((visit.childOffset ?? 0) < visit.node.children.length) {
      const offset = visit.childOffset ?? 0;
      pending = { id: visit.node.children[offset]!, next: { ...visit, childOffset: offset + 1, next: pending } };
    } else {
      marks = marks.with(visit.id, "done");
      postorder = postorder.with(String(postorder.size).padStart(16, "0"), visit.node);
    }
  }
  return { traversal: { pending, root_offset: rootOffset, marks, nodes, leaves, postorder, invalid }, work,
    complete: pending === null && rootOffset === input.roots.length && !invalid };
}

export function localLeafIds(traversal: DerivationTraversal): ReadonlySet<string> {
  return new Set([...traversal.leaves.values()].flatMap((leaf) => leaf.leaf_ids));
}
