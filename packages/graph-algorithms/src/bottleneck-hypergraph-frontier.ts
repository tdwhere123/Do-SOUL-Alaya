export interface PriorityFrontier {
  buildFromTentative(tentative: Float64Array): { readonly pushes: number; readonly comparisons: number };
  push(node: number, grade: number): void;
  peekValid(tentative: Float64Array, settled: Uint8Array): { readonly node: number; readonly grade: number } | undefined;
  popValid(tentative: Float64Array, settled: Uint8Array): { readonly node: number; readonly grade: number } | undefined;
}

const BUCKET_MAX_TOP = 4096;

export function createFrontier(top: number): PriorityFrontier {
  return top <= BUCKET_MAX_TOP ? createBucketFrontier(top) : createHeapFrontier();
}

function createBucketFrontier(top: number): PriorityFrontier {
  const buckets: number[][] = Array.from({ length: top + 1 }, () => []);
  let cursor = top;
  const peekValid = (tentative: Float64Array, settled: Uint8Array) => {
    while (cursor >= 0) {
      const bucket = buckets[cursor]!;
      while (bucket.length > 0) {
        const node = bucket[bucket.length - 1]!;
        if (settled[node] === 1 || tentative[node] !== cursor) {
          bucket.pop();
          continue;
        }
        return { node, grade: cursor };
      }
      cursor -= 1;
    }
    return undefined;
  };
  return {
    buildFromTentative(tentative: Float64Array) {
      let pushes = 0;
      for (let u = 0; u < tentative.length; u += 1) {
        const grade = tentative[u]!;
        if (grade >= 0) {
          buckets[grade]!.push(u);
          if (grade > cursor) cursor = grade;
          pushes += 1;
        }
      }
      return { pushes, comparisons: 0 };
    },
    push(node: number, grade: number): void {
      buckets[grade]!.push(node);
      if (grade > cursor) cursor = grade;
    },
    peekValid,
    popValid(tentative: Float64Array, settled: Uint8Array) {
      const topEntry = peekValid(tentative, settled);
      if (topEntry !== undefined) buckets[topEntry.grade]!.pop();
      return topEntry;
    }
  };
}

function createHeapFrontier(): PriorityFrontier {
  const nodes: number[] = [];
  const grades: number[] = [];
  let heapComparisons = 0;
  const swap = (a: number, b: number): void => {
    [nodes[a], nodes[b]] = [nodes[b]!, nodes[a]!];
    [grades[a], grades[b]] = [grades[b]!, grades[a]!];
  };
  const siftUp = (idx: number): void => {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (grades[parent]! >= grades[idx]!) break;
      swap(parent, idx);
      idx = parent;
    }
  };
  const siftDown = (idx: number): void => {
    const len = nodes.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let largest = idx;
      if (left < len) {
        heapComparisons += 1;
        if (grades[left]! > grades[largest]!) largest = left;
      }
      if (right < len) {
        heapComparisons += 1;
        if (grades[right]! > grades[largest]!) largest = right;
      }
      if (largest === idx) break;
      swap(idx, largest);
      idx = largest;
    }
  };
  const popRaw = (): void => {
    const lastNode = nodes.pop()!;
    const lastGrade = grades.pop()!;
    if (nodes.length > 0) {
      nodes[0] = lastNode;
      grades[0] = lastGrade;
      siftDown(0);
    }
  };
  const peekValid = (tentative: Float64Array, settled: Uint8Array) => {
    while (nodes.length > 0) {
      const node = nodes[0]!;
      const grade = grades[0]!;
      if (settled[node] === 1 || tentative[node] !== grade) {
        popRaw();
        continue;
      }
      return { node, grade };
    }
    return undefined;
  };
  return {
    buildFromTentative(tentative: Float64Array) {
      for (let u = 0; u < tentative.length; u += 1) {
        const grade = tentative[u]!;
        if (grade >= 0) {
          nodes.push(u);
          grades.push(grade);
        }
      }
      const startComparisons = heapComparisons;
      for (let idx = (nodes.length >> 1) - 1; idx >= 0; idx -= 1) {
        siftDown(idx);
      }
      return { pushes: nodes.length, comparisons: heapComparisons - startComparisons };
    },
    push(node: number, grade: number): void {
      nodes.push(node);
      grades.push(grade);
      siftUp(nodes.length - 1);
    },
    peekValid,
    popValid(tentative: Float64Array, settled: Uint8Array) {
      const topEntry = peekValid(tentative, settled);
      if (topEntry !== undefined) popRaw();
      return topEntry;
    }
  };
}
