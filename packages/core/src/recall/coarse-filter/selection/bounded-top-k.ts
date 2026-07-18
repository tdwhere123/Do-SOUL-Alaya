export function selectBoundedTopK<T>(
  values: Iterable<T>,
  limit: number,
  compare: (left: T, right: T) => number
): T[] {
  if (limit <= 0) {
    return [];
  }
  const worstFirstHeap: T[] = [];
  for (const value of values) {
    if (worstFirstHeap.length < limit) {
      worstFirstHeap.push(value);
      bubbleWorstUp(worstFirstHeap, worstFirstHeap.length - 1, compare);
      continue;
    }
    if (compare(value, worstFirstHeap[0]!) < 0) {
      worstFirstHeap[0] = value;
      sinkWorstDown(worstFirstHeap, compare);
    }
  }
  return worstFirstHeap.sort(compare);
}

function bubbleWorstUp<T>(
  heap: T[],
  startIndex: number,
  compare: (left: T, right: T) => number
): void {
  let index = startIndex;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    if (compare(heap[index]!, heap[parentIndex]!) <= 0) {
      return;
    }
    [heap[parentIndex], heap[index]] = [heap[index]!, heap[parentIndex]!];
    index = parentIndex;
  }
}

function sinkWorstDown<T>(heap: T[], compare: (left: T, right: T) => number): void {
  let index = 0;
  while (true) {
    const leftIndex = index * 2 + 1;
    if (leftIndex >= heap.length) {
      return;
    }
    const rightIndex = leftIndex + 1;
    const worseChildIndex =
      rightIndex < heap.length && compare(heap[rightIndex]!, heap[leftIndex]!) > 0
        ? rightIndex
        : leftIndex;
    if (compare(heap[worseChildIndex]!, heap[index]!) <= 0) {
      return;
    }
    [heap[index], heap[worseChildIndex]] = [heap[worseChildIndex]!, heap[index]!];
    index = worseChildIndex;
  }
}
