interface TarjanState {
  index: number;
  componentCount: number;
  readonly stack: string[];
  readonly onStack: Set<string>;
  readonly indices: Map<string, number>;
  readonly lowLinks: Map<string, number>;
}

export {
  parseRelativeTemporalTerm,
  resolveRelativeTemporalWindow,
  type RelativeTemporalTerm,
  type TemporalWindow
} from "./temporal-window.js";

export function countStronglyConnectedComponents(
  nodeKeys: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  invariantLabel = "path graph"
): number {
  const state = createTarjanState();
  for (const nodeKey of nodeKeys) {
    if (!state.indices.has(nodeKey)) {
      strongConnectNode(nodeKey, adjacency, state, invariantLabel);
    }
  }
  return state.componentCount;
}

function createTarjanState(): TarjanState {
  return {
    index: 0,
    componentCount: 0,
    stack: [],
    onStack: new Set<string>(),
    indices: new Map<string, number>(),
    lowLinks: new Map<string, number>()
  };
}

function strongConnectNode(
  nodeKey: string,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  state: TarjanState,
  invariantLabel: string
): void {
  trackTarjanNode(nodeKey, state);
  for (const neighbor of adjacency.get(nodeKey) ?? []) {
    if (!state.indices.has(neighbor)) {
      strongConnectNode(neighbor, adjacency, state, invariantLabel);
      state.lowLinks.set(
        nodeKey,
        Math.min(
          readTrackedNumber(state.lowLinks, nodeKey, "low-link", invariantLabel),
          readTrackedNumber(state.lowLinks, neighbor, "low-link", invariantLabel)
        )
      );
    } else if (state.onStack.has(neighbor)) {
      state.lowLinks.set(
        nodeKey,
        Math.min(
          readTrackedNumber(state.lowLinks, nodeKey, "low-link", invariantLabel),
          readTrackedNumber(state.indices, neighbor, "index", invariantLabel)
        )
      );
    }
  }
  if (
    readTrackedNumber(state.lowLinks, nodeKey, "low-link", invariantLabel) ===
    readTrackedNumber(state.indices, nodeKey, "index", invariantLabel)
  ) {
    settleStronglyConnectedComponent(nodeKey, state, invariantLabel);
  }
}

function trackTarjanNode(nodeKey: string, state: TarjanState): void {
  state.indices.set(nodeKey, state.index);
  state.lowLinks.set(nodeKey, state.index);
  state.index += 1;
  state.stack.push(nodeKey);
  state.onStack.add(nodeKey);
}

function settleStronglyConnectedComponent(
  nodeKey: string,
  state: TarjanState,
  invariantLabel: string
): void {
  state.componentCount += 1;
  while (state.stack.length > 0) {
    const candidate = state.stack.pop();
    if (candidate === undefined) {
      throw new Error(`${invariantLabel} Tarjan invariant violated: stack underflow.`);
    }
    state.onStack.delete(candidate);
    if (candidate === nodeKey) {
      return;
    }
  }
}

function readTrackedNumber(
  trackedValues: ReadonlyMap<string, number>,
  nodeKey: string,
  label: string,
  invariantLabel: string
): number {
  const value = trackedValues.get(nodeKey);
  if (value === undefined) {
    throw new Error(`${invariantLabel} Tarjan invariant violated: missing ${label} for ${nodeKey}.`);
  }

  return value;
}
