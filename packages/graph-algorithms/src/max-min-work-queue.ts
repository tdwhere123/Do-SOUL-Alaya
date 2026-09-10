import type { MaxMinWorkItem } from "./max-min-field.js";

type Node = Readonly<{ item: MaxMinWorkItem; left?: Node; right?: Node; rank: number; size: number }>;

/** Persistent leftist heap keeps an interrupted frontier without replaying its entries. */
export class MaxMinWorkQueue {
  public constructor(private readonly root?: Node) {}
  public get size(): number { return this.root?.size ?? 0; }
  public push(item: MaxMinWorkItem): MaxMinWorkQueue {
    return new MaxMinWorkQueue(merge(this.root, { item, rank: 1, size: 1 }));
  }
  public pop(): Readonly<{ item: MaxMinWorkItem; queue: MaxMinWorkQueue }> | undefined {
    if (this.root === undefined) return undefined;
    return { item: this.root.item, queue: new MaxMinWorkQueue(merge(this.root.left, this.root.right)) };
  }
  public *[Symbol.iterator](): Generator<MaxMinWorkItem> {
    const pending = this.root === undefined ? [] : [this.root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      yield current.item;
      if (current.left !== undefined) pending.push(current.left);
      if (current.right !== undefined) pending.push(current.right);
    }
  }
}

function merge(first: Node | undefined, second: Node | undefined): Node | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  if (first.item.strength < second.item.strength) [first, second] = [second, first];
  let left = first.left;
  let right = merge(first.right, second);
  if ((left?.rank ?? 0) < (right?.rank ?? 0)) [left, right] = [right, left];
  return { item: first.item, left, right, rank: 1 + (right?.rank ?? 0), size: 1 + (left?.size ?? 0) + (right?.size ?? 0) };
}
