import {
  ProjectMappingState,
  ScopeClassSchema,
  ScopeClass,
  SoulGraphEdgeSchema,
  SoulGraphNodeSchema,
  SoulGraphSchema,
  parseSoulGraphDepth,
  parseSoulGraphLimit,
  type GlobalMemoryEntry,
  type MemoryEntry,
  type MemoryGraphEdge,
  type ProjectMappingAnchor,
  type Run,
  type SoulGraph,
  type SoulGraphEdge,
  type SoulGraphNode,
  type CandidateMemorySignal
} from "@do-what/protocol";

export interface SoulGraphAggregatorDependencies {
  readonly memoryRepo: {
    findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  };
  readonly edgeRepo: {
    findByWorkspace(workspaceId: string): Promise<readonly Readonly<MemoryGraphEdge>[]>;
  };
  readonly runRepo: {
    listByWorkspace(workspaceId: string): Promise<readonly Readonly<Run>[]>;
  };
  readonly signalRepo: {
    listByRun(runId: string): Promise<readonly Readonly<CandidateMemorySignal>[]>;
  };
  readonly projectMappingRepo?: {
    findByWorkspace(workspaceId: string): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
  };
  readonly globalMemoryRepo?: {
    findByGlobalObjectId(globalObjectId: string): Promise<Readonly<GlobalMemoryEntry> | null>;
  };
}

export interface BuildSoulGraphParams {
  readonly workspaceId: string;
  readonly depth?: number;
  readonly limit?: number;
}

export class SoulGraphAggregator {
  public constructor(private readonly deps: SoulGraphAggregatorDependencies) {}

  public async buildSoulGraph(params: BuildSoulGraphParams): Promise<SoulGraph> {
    const workspaceId = parseWorkspaceId(params.workspaceId);
    const depth = parseSoulGraphDepth(params.depth);
    const limit = parseSoulGraphLimit(params.limit);
    const builder = new OrderedSoulGraphBuilder(workspaceId, limit);
    const localMemories = sortByCreatedAt(await this.deps.memoryRepo.findByWorkspaceId(workspaceId), (memory) => memory.object_id);
    const localMemoryIds = new Set(localMemories.map((memory) => memory.object_id));

    for (const memory of localMemories) {
      builder.addNode(toProjectMemoryNode(workspaceId, memory));
    }

    for (const memory of localMemories) {
      const scopeNode = toScopeNode(workspaceId, memory.scope_class);
      builder.addNode(scopeNode);
      builder.addEdge(
        SoulGraphEdgeSchema.parse({
          id: buildBelongsToEdgeId(projectMemoryNodeId(memory.object_id), scopeNode.id),
          kind: "belongs_to",
          source_id: projectMemoryNodeId(memory.object_id),
          target_id: scopeNode.id,
          created_at: memory.created_at
        })
      );
    }

    const memoryEdges = await this.collectLocalMemoryEdges(workspaceId, localMemories);
    for (const edge of memoryEdges) {
      if (!localMemoryIds.has(edge.source_memory_id) || !localMemoryIds.has(edge.target_memory_id)) {
        continue;
      }

      if (edge.edge_type !== "derives_from") {
        continue;
      }

      builder.addEdge(
        SoulGraphEdgeSchema.parse({
          id: `derived_from:${edge.edge_id}`,
          kind: "derived_from",
          source_id: projectMemoryNodeId(edge.source_memory_id),
          target_id: projectMemoryNodeId(edge.target_memory_id),
          created_at: edge.created_at
        })
      );
    }

    if (depth >= 2) {
      const runs = sortByCreatedAt(await this.deps.runRepo.listByWorkspace(workspaceId), (run) => run.run_id);

      for (const run of runs) {
        const signals = sortByCreatedAt(await this.deps.signalRepo.listByRun(run.run_id), (signal) => signal.signal_id);
        for (const signal of signals) {
          const scopeClass = parseScopeClass(signal.scope_hint);
          builder.addNode(toSignalNode(workspaceId, signal, scopeClass));

          if (scopeClass !== undefined) {
            const scopeNode = toScopeNode(workspaceId, scopeClass);
            builder.addNode(scopeNode);
            builder.addEdge(
              SoulGraphEdgeSchema.parse({
                id: buildBelongsToEdgeId(signalNodeId(signal.signal_id), scopeNode.id),
                kind: "belongs_to",
                source_id: signalNodeId(signal.signal_id),
                target_id: scopeNode.id,
                created_at: signal.created_at
              })
            );
          }

          for (const memoryId of extractReferencedMemoryIds(signal)) {
            if (!localMemoryIds.has(memoryId)) {
              continue;
            }

            builder.addEdge(
              SoulGraphEdgeSchema.parse({
                id: `references:${signal.signal_id}:${memoryId}`,
                kind: "references",
                source_id: signalNodeId(signal.signal_id),
                target_id: projectMemoryNodeId(memoryId),
                created_at: signal.created_at
              })
            );
          }
        }
      }

      if (this.deps.projectMappingRepo !== undefined && this.deps.globalMemoryRepo !== undefined) {
        const adoptedAnchors = (await this.deps.projectMappingRepo.findByWorkspace(workspaceId))
          .filter(
            (anchor) =>
              anchor.mapping_state === ProjectMappingState.ACCEPTED ||
              anchor.mapping_state === ProjectMappingState.ADAPTED
          )
          .sort((left, right) => compareByCreatedAt(left.last_transition_at, left.object_id, right.last_transition_at, right.object_id));

        for (const anchor of adoptedAnchors) {
          const entry = await this.deps.globalMemoryRepo.findByGlobalObjectId(anchor.global_object_id);
          if (entry === null) {
            continue;
          }

          const scopeNode = toScopeNode(workspaceId, entry.scope_class);
          const memoryNode = toGlobalMemoryNode(workspaceId, entry);
          builder.addNode(scopeNode);
          builder.addNode(memoryNode);
          builder.addEdge(
            SoulGraphEdgeSchema.parse({
              id: buildBelongsToEdgeId(memoryNode.id, scopeNode.id),
              kind: "belongs_to",
              source_id: memoryNode.id,
              target_id: scopeNode.id,
              created_at: entry.created_at
            })
          );
        }
      }
    }

    return builder.build();
  }

  private async collectLocalMemoryEdges(
    workspaceId: string,
    localMemories: readonly Readonly<MemoryEntry>[]
  ): Promise<readonly Readonly<MemoryGraphEdge>[]> {
    const localMemoryIds = new Set(localMemories.map((memory) => memory.object_id));
    const workspaceEdges = await this.deps.edgeRepo.findByWorkspace(workspaceId);

    return workspaceEdges.filter(
      (edge) =>
        localMemoryIds.has(edge.source_memory_id) &&
        localMemoryIds.has(edge.target_memory_id)
    );
  }
}

class OrderedSoulGraphBuilder {
  private readonly includedNodes = new Map<string, SoulGraphNode>();
  private readonly includedEdges = new Map<string, SoulGraphEdge>();
  private readonly nodeIds = new Set<string>();
  private readonly edgeIds = new Set<string>();
  private truncated = false;

  public constructor(
    private readonly workspaceId: string,
    private readonly limit: number
  ) {}

  public addNode(node: SoulGraphNode): void {
    if (this.nodeIds.has(node.id)) {
      return;
    }

    this.nodeIds.add(node.id);
    if (this.includedNodes.size < this.limit) {
      this.includedNodes.set(node.id, node);
      return;
    }

    this.truncated = true;
  }

  public addEdge(edge: SoulGraphEdge): void {
    if (this.edgeIds.has(edge.id)) {
      return;
    }

    this.edgeIds.add(edge.id);
    if (this.includedNodes.has(edge.source_id) && this.includedNodes.has(edge.target_id)) {
      this.includedEdges.set(edge.id, edge);
    }
  }

  public build(): SoulGraph {
    return SoulGraphSchema.parse({
      workspace_id: this.workspaceId,
      nodes: [...this.includedNodes.values()],
      edges: [...this.includedEdges.values()],
      truncated: this.truncated,
      node_total: this.nodeIds.size,
      edge_total: this.edgeIds.size
    });
  }
}

function toProjectMemoryNode(workspaceId: string, memory: Readonly<MemoryEntry>): SoulGraphNode {
  return SoulGraphNodeSchema.parse({
    id: projectMemoryNodeId(memory.object_id),
    kind: "memory",
    label: summarizeText(memory.content),
    summary: `${memory.dimension} · ${memory.scope_class}`,
    scope_id: scopeNodeId(memory.scope_class),
    workspace_id: workspaceId,
    created_at: memory.created_at,
    origin_plane: "project"
  });
}

function toGlobalMemoryNode(workspaceId: string, entry: Readonly<GlobalMemoryEntry>): SoulGraphNode {
  return SoulGraphNodeSchema.parse({
    id: globalMemoryNodeId(entry.global_object_id),
    kind: "memory",
    label: summarizeText(entry.content),
    summary: `${entry.dimension} · ${entry.scope_class} · global`,
    scope_id: scopeNodeId(entry.scope_class),
    workspace_id: workspaceId,
    created_at: entry.created_at,
    origin_plane: "global"
  });
}

function toSignalNode(
  workspaceId: string,
  signal: Readonly<CandidateMemorySignal>,
  scopeClass: ScopeClass | undefined
): SoulGraphNode {
  return SoulGraphNodeSchema.parse({
    id: signalNodeId(signal.signal_id),
    kind: "signal",
    label: signal.signal_kind,
    summary: signal.object_kind,
    ...(scopeClass === undefined ? {} : { scope_id: scopeNodeId(scopeClass) }),
    workspace_id: workspaceId,
    created_at: signal.created_at
  });
}

function toScopeNode(workspaceId: string, scopeClass: ScopeClass): SoulGraphNode {
  return SoulGraphNodeSchema.parse({
    id: scopeNodeId(scopeClass),
    kind: "scope",
    label: scopeClass,
    workspace_id: workspaceId
  });
}

function projectMemoryNodeId(objectId: string): string {
  return `memory:${objectId}`;
}

function globalMemoryNodeId(globalObjectId: string): string {
  return `memory:global:${globalObjectId}`;
}

function signalNodeId(signalId: string): string {
  return `signal:${signalId}`;
}

function scopeNodeId(scopeClass: ScopeClass): string {
  return `scope:${scopeClass}`;
}

function buildBelongsToEdgeId(sourceId: string, targetId: string): string {
  return `belongs_to:${sourceId}:${targetId}`;
}

function parseWorkspaceId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("workspaceId is required");
  }

  return trimmed;
}

function summarizeText(value: string, maxLength = 48): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function parseScopeClass(value: string | null): ScopeClass | undefined {
  if (value === null) {
    return undefined;
  }

  const result = ScopeClassSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function extractReferencedMemoryIds(signal: Readonly<CandidateMemorySignal>): readonly string[] {
  const rawRefs = signal.raw_payload["source_memory_refs"];
  if (!Array.isArray(rawRefs)) {
    return [];
  }

  const normalizedRefs = rawRefs.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }

    const trimmed = entry.trim();
    return trimmed.length === 0 ? [] : [trimmed];
  });

  return [...new Set(normalizedRefs)];
}

function sortByCreatedAt<T extends { readonly created_at: string }>(
  items: readonly T[],
  tieBreaker: (value: T) => string
): readonly T[] {
  return sortByTimestamp(
    items,
    (value) => value.created_at,
    tieBreaker
  );
}

function sortByTimestamp<T>(
  items: readonly T[],
  getTimestamp: (value: T) => string,
  tieBreaker: (value: T) => string
): readonly T[] {
  return [...items].sort((left, right) =>
    compareByCreatedAt(getTimestamp(left), tieBreaker(left), getTimestamp(right), tieBreaker(right))
  );
}

function compareByCreatedAt(
  leftCreatedAt: string,
  leftTieBreaker: string,
  rightCreatedAt: string,
  rightTieBreaker: string
): number {
  if (leftCreatedAt < rightCreatedAt) {
    return -1;
  }

  if (leftCreatedAt > rightCreatedAt) {
    return 1;
  }

  return leftTieBreaker.localeCompare(rightTieBreaker);
}
