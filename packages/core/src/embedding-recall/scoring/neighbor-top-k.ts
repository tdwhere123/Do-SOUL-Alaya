import type { EmbeddingNeighborHit } from "../types.js";

export function compareNeighborHits(
  left: Readonly<EmbeddingNeighborHit>,
  right: Readonly<EmbeddingNeighborHit>
): number {
  const delta = right.normalized_similarity - left.normalized_similarity;
  return delta !== 0 ? delta : left.object_id.localeCompare(right.object_id);
}

// Exact top-K: same set and order as [...hits].sort(compareNeighborHits).slice(0, k).
export function selectTopNeighborHits(
  hits: readonly Readonly<EmbeddingNeighborHit>[],
  maxNeighbors: number
): readonly Readonly<EmbeddingNeighborHit>[] {
  if (maxNeighbors <= 0 || hits.length === 0) {
    return Object.freeze([]);
  }
  if (hits.length <= maxNeighbors) {
    return Object.freeze([...hits].sort(compareNeighborHits));
  }

  const heap: Readonly<EmbeddingNeighborHit>[] = [];
  for (const hit of hits) {
    if (heap.length < maxNeighbors) {
      heap.push(hit);
      bubbleWorseUp(heap, heap.length - 1);
      continue;
    }
    if (compareNeighborHits(hit, heap[0]!) < 0) {
      heap[0] = hit;
      sinkWorseDown(heap, 0);
    }
  }
  return Object.freeze(heap.sort(compareNeighborHits));
}

function isWorse(
  left: Readonly<EmbeddingNeighborHit>,
  right: Readonly<EmbeddingNeighborHit>
): boolean {
  return compareNeighborHits(left, right) > 0;
}

function bubbleWorseUp(
  heap: Readonly<EmbeddingNeighborHit>[],
  index: number
): void {
  let current = index;
  while (current > 0) {
    const parent = (current - 1) >> 1;
    if (!isWorse(heap[current]!, heap[parent]!)) {
      break;
    }
    swap(heap, current, parent);
    current = parent;
  }
}

function sinkWorseDown(
  heap: Readonly<EmbeddingNeighborHit>[],
  index: number
): void {
  let current = index;
  for (;;) {
    const left = current * 2 + 1;
    const right = left + 1;
    let worst = current;
    if (left < heap.length && isWorse(heap[left]!, heap[worst]!)) {
      worst = left;
    }
    if (right < heap.length && isWorse(heap[right]!, heap[worst]!)) {
      worst = right;
    }
    if (worst === current) {
      break;
    }
    swap(heap, current, worst);
    current = worst;
  }
}

function swap(
  heap: Readonly<EmbeddingNeighborHit>[],
  left: number,
  right: number
): void {
  const tmp = heap[left]!;
  heap[left] = heap[right]!;
  heap[right] = tmp;
}
