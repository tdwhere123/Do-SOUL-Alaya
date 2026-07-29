import {
  MemoryGovernanceEventType,
  type PathRelation,
  type SoulGraph
} from "@do-soul/alaya-protocol";
import type {
  PathRelationRepo,
  ProposalRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo
} from "@do-soul/alaya-storage";
import {
  buildDomainTagProjection,
  buildInfluenceCounts,
  buildPathRelationEdges,
  buildPendingProposalProjection,
  buildUserReviewedMemoryIds,
  classifySoulGraphOriginKind,
  countDomainTagEdges,
  countPathRelationEdges,
  countUniqueDomainTags,
  deriveDomainTagSummary,
  deriveMemoryNodeLabel,
  deriveMemoryNodeSummary,
  deriveMemoryRationale,
  type SoulGraphMemoryEntryRecord
} from "./soul-graph-projection.js";

export { classifySoulGraphOriginKind, deriveDomainTagSummary };

const SOUL_GRAPH_STORAGE_PAGE_LIMIT = 500;

export function createSoulGraphService(input: {
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly pathRelationRepo: Pick<PathRelationRepo, "findActive" | "findActivePage">;
  readonly proposalRepo: Pick<
    ProposalRepo,
    "findPendingSummaries" | "countPending" | "countPendingMemoryTargetEdges"
  >;
  readonly eventLogRepo: Pick<SqliteEventLogRepo, "queryByWorkspaceAndType">;
  readonly now?: () => string;
}) {
  return {
    buildSoulGraph: async (request: {
      readonly workspaceId: string;
      readonly depth: number;
      readonly limit: number;
    }) => await buildSoulGraph(input, request.workspaceId, request.limit)
  };
}

function buildMemoryNode(
  memory: SoulGraphMemoryEntryRecord,
  hasAcceptedProposalApply: boolean,
  influenceCounts: ReadonlyMap<string, number>
): SoulGraph["nodes"][number] {
  const label = deriveMemoryNodeLabel(memory.content);
  const summary = deriveMemoryNodeSummary(memory.content, label);
  const node: SoulGraph["nodes"][number] = {
    id: memory.object_id,
    kind: "memory",
    label,
    workspace_id: memory.workspace_id,
    created_at: memory.created_at,
    scope_id: memory.scope_class,
    origin_plane: memory.scope_class === "project" ? "project" : "global",
    origin_kind: classifySoulGraphOriginKind(memory, hasAcceptedProposalApply),
    evidence_refs: memory.evidence_refs.length === 0 ? undefined : [...memory.evidence_refs],
    rationale: deriveMemoryRationale(memory, hasAcceptedProposalApply),
    confidence: memory.confidence ?? undefined,
    last_used_at: memory.last_used_at ?? undefined,
    last_hit_at: memory.last_hit_at ?? undefined,
    influence_count: influenceCounts.get(memory.object_id) ?? 0
  };
  return summary === undefined ? node : { ...node, summary };
}

interface LimitedRows<T> {
  readonly rows: readonly T[];
  readonly truncated: boolean;
}

async function collectSoulGraphMemories(
  memoryEntryRepo: SqliteMemoryEntryRepo,
  workspaceId: string,
  limit: number
): Promise<LimitedRows<SoulGraphMemoryEntryRecord>> {
  return await collectLimitedRows(limit, async (page) =>
    await memoryEntryRepo.findByWorkspaceId(workspaceId, undefined, page)
  );
}

async function collectSoulGraphActivePaths(
  pathRelationRepo: Pick<PathRelationRepo, "findActive" | "findActivePage">,
  workspaceId: string,
  limit: number
): Promise<LimitedRows<Readonly<PathRelation>>> {
  const findActivePage = pathRelationRepo.findActivePage;
  if (findActivePage === undefined) {
    const rows = await pathRelationRepo.findActive(workspaceId);
    return Object.freeze({ rows: Object.freeze(rows.slice(0, limit)), truncated: rows.length > limit });
  }

  return await collectLimitedRows(limit, async (page) =>
    await findActivePage.call(pathRelationRepo, workspaceId, page)
  );
}

async function buildSoulGraph(
  input: {
    readonly memoryEntryRepo: SqliteMemoryEntryRepo;
    readonly pathRelationRepo: Pick<PathRelationRepo, "findActive" | "findActivePage">;
    readonly proposalRepo: Pick<
      ProposalRepo,
      "findPendingSummaries" | "countPending" | "countPendingMemoryTargetEdges"
    >;
    readonly eventLogRepo: Pick<SqliteEventLogRepo, "queryByWorkspaceAndType">;
    readonly now?: () => string;
  },
  workspaceId: string,
  limit: number
): Promise<SoulGraph> {
  const sourceData = await collectSoulGraphSourceData(input, workspaceId, limit);
  const limitedMemories = sourceData.memories.slice(0, limit);
  const memoryIds = new Set(limitedMemories.map((memory) => memory.object_id));
  const pathRelationEdges = buildPathRelationEdges(sourceData.pathRelations, memoryIds).slice(0, limit);
  const tagProjection = buildDomainTagProjection(limitedMemories);
  const influenceCounts = buildInfluenceCounts(sourceData.pathRelations);
  const proposalProjection = buildPendingProposalProjection(sourceData.pendingProposals, memoryIds);
  const userReviewedMemoryIds = buildUserReviewedMemoryIds(sourceData.memoryUpdateEvents);

  return {
    workspace_id: workspaceId,
    nodes: [
      ...limitedMemories.map((memory) =>
        buildMemoryNode(memory, userReviewedMemoryIds.has(memory.object_id), influenceCounts)
      ),
      ...proposalProjection.nodes,
      ...tagProjection.nodes
    ],
    edges: [...pathRelationEdges, ...proposalProjection.edges, ...tagProjection.edges],
    truncated:
      sourceData.memoryRows.truncated ||
      sourceData.pathRelationRows.truncated ||
      sourceData.pathRelations.length > pathRelationEdges.length ||
      sourceData.pendingProposalsTotal > sourceData.pendingProposals.length,
    node_total:
      (sourceData.memoryTotal ?? sourceData.memories.length) +
      sourceData.pendingProposalsTotal +
      countUniqueDomainTags(sourceData.memories),
    edge_total:
      countPathRelationEdges(sourceData.pathRelations, sourceData.allMemoryIdSet) +
      sourceData.pendingProposalEdgesTotal +
      countDomainTagEdges(sourceData.memories)
  };
}

async function collectSoulGraphSourceData(
  input: {
    readonly memoryEntryRepo: SqliteMemoryEntryRepo;
    readonly pathRelationRepo: Pick<PathRelationRepo, "findActive" | "findActivePage">;
    readonly proposalRepo: Pick<
      ProposalRepo,
      "findPendingSummaries" | "countPending" | "countPendingMemoryTargetEdges"
    >;
    readonly eventLogRepo: Pick<SqliteEventLogRepo, "queryByWorkspaceAndType">;
    readonly now?: () => string;
  },
  workspaceId: string,
  limit: number
) {
  const [
    memoryRows,
    pathRelationRows,
    pendingProposals,
    pendingProposalsTotal,
    memoryUpdateEvents,
    memoryTotal
  ] = await Promise.all([
    collectSoulGraphMemories(input.memoryEntryRepo, workspaceId, limit),
    collectSoulGraphActivePaths(input.pathRelationRepo, workspaceId, limit),
    input.proposalRepo.findPendingSummaries(workspaceId, { limit, now: input.now?.() }),
    input.proposalRepo.countPending(workspaceId),
    input.eventLogRepo.queryByWorkspaceAndType(
      workspaceId,
      MemoryGovernanceEventType.SOUL_MEMORY_UPDATED
    ),
    typeof input.memoryEntryRepo.countByWorkspaceId === "function"
      ? input.memoryEntryRepo.countByWorkspaceId(workspaceId)
      : Promise.resolve(null)
  ]);
  const memories = memoryRows.rows;
  const pathRelations = pathRelationRows.rows;
  const allMemoryIds = memories.map((memory) => memory.object_id);
  return {
    memoryRows,
    pathRelationRows,
    pendingProposals,
    pendingProposalsTotal,
    memoryUpdateEvents,
    memoryTotal,
    memories,
    pathRelations,
    allMemoryIdSet: new Set(allMemoryIds),
    pendingProposalEdgesTotal: await countPendingProposalEdges(input.proposalRepo, workspaceId, allMemoryIds)
  };
}

async function countPendingProposalEdges(
  proposalRepo: Pick<ProposalRepo, "countPendingMemoryTargetEdges">,
  workspaceId: string,
  allMemoryIds: readonly string[]
): Promise<number> {
  return await proposalRepo.countPendingMemoryTargetEdges(workspaceId, allMemoryIds);
}

async function collectLimitedRows<T>(
  limit: number,
  readPage: (page: { readonly limit: number; readonly offset: number }) => Promise<readonly T[]>
): Promise<LimitedRows<T>> {
  const rows: T[] = [];
  let truncated = false;
  for (let offset = 0; rows.length < limit; offset += SOUL_GRAPH_STORAGE_PAGE_LIMIT) {
    const remaining = limit - rows.length;
    const pageLimit = Math.min(SOUL_GRAPH_STORAGE_PAGE_LIMIT, remaining);
    const pageRows = await readPage({ limit: pageLimit, offset });
    rows.push(...pageRows.slice(0, remaining));
    truncated = pageRows.length > remaining;
    if (truncated || pageRows.length < pageLimit) {
      break;
    }
    if (rows.length === limit) {
      truncated = (await readPage({ limit: 1, offset: offset + pageLimit })).length > 0;
      break;
    }
  }
  return Object.freeze({ rows: Object.freeze(rows), truncated });
}
