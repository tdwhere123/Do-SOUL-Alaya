type Node<V> = Readonly<{ key: string; value: V; left?: Node<V>; right?: Node<V>; height: number; size: number }>;

/** Immutable AVL index: adding a frontier does not copy the previously solved graph. */
export class PersistentStringMap<V> implements ReadonlyMap<string, V> {
  public constructor(private readonly root?: Node<V>) {}
  public get size(): number { return this.root?.size ?? 0; }
  public get [Symbol.toStringTag](): string { return "PersistentStringMap"; }

  public get(key: string): V | undefined {
    let node = this.root;
    while (node !== undefined) {
      if (key === node.key) return node.value;
      node = key < node.key ? node.left : node.right;
    }
    return undefined;
  }

  public has(key: string): boolean {
    let node = this.root;
    while (node !== undefined) {
      if (key === node.key) return true;
      node = key < node.key ? node.left : node.right;
    }
    return false;
  }

  public entryAt(index: number): readonly [string, V] | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.size) return undefined;
    let current = this.root;
    while (current !== undefined) {
      const left = current.left?.size ?? 0;
      if (index === left) return [current.key, current.value];
      if (index < left) current = current.left;
      else { index -= left + 1; current = current.right; }
    }
    return undefined;
  }

  public with(key: string, value: V): PersistentStringMap<V> {
    const root = insert(this.root, key, value);
    return root === this.root ? this : new PersistentStringMap(root);
  }

  public *entries(): MapIterator<[string, V]> { yield* entries(this.root); }
  public *keys(): MapIterator<string> { for (const [key] of this) yield key; }
  public *values(): MapIterator<V> { for (const [, value] of this) yield value; }
  public [Symbol.iterator](): MapIterator<[string, V]> { return this.entries(); }
  public forEach(callback: (value: V, key: string, map: ReadonlyMap<string, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
}

function node<V>(key: string, value: V, left?: Node<V>, right?: Node<V>): Node<V> {
  return { key, value, left, right, height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0),
    size: 1 + (left?.size ?? 0) + (right?.size ?? 0) };
}

function insert<V>(current: Node<V> | undefined, key: string, value: V): Node<V> {
  if (current === undefined) return node(key, value);
  if (key === current.key) return value === current.value ? current : node(key, value, current.left, current.right);
  const next = key < current.key
    ? node(current.key, current.value, insert(current.left, key, value), current.right)
    : node(current.key, current.value, current.left, insert(current.right, key, value));
  const balance = (next.left?.height ?? 0) - (next.right?.height ?? 0);
  if (balance > 1) {
    const left = next.left!;
    return rotateRight((left.left?.height ?? 0) >= (left.right?.height ?? 0) ? next
      : node(next.key, next.value, rotateLeft(left), next.right));
  }
  if (balance < -1) {
    const right = next.right!;
    return rotateLeft((right.right?.height ?? 0) >= (right.left?.height ?? 0) ? next
      : node(next.key, next.value, next.left, rotateRight(right)));
  }
  return next;
}

function rotateLeft<V>(root: Node<V>): Node<V> {
  const next = root.right!;
  return node(next.key, next.value, node(root.key, root.value, root.left, next.left), next.right);
}

function rotateRight<V>(root: Node<V>): Node<V> {
  const next = root.left!;
  return node(next.key, next.value, next.left, node(root.key, root.value, next.right, root.right));
}

function* entries<V>(root: Node<V> | undefined): Generator<[string, V]> {
  if (root === undefined) return;
  yield* entries(root.left);
  yield [root.key, root.value];
  yield* entries(root.right);
}
