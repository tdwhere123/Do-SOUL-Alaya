import {
  isPathActiveForRecall,
  RuntimeGovernanceEventType,
  type EventLogEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type {
  EventLogRepo,
  PathRelationRepo
} from "@do-soul/alaya-storage";

export type GraphHealthStatus = "healthy" | "degraded";
export type GraphHealthWarning = "path_relations_empty";

export interface GraphHealthSnapshot {
  readonly workspace_id: string;
  readonly status: GraphHealthStatus;
  readonly path_relations_total: number;
  readonly path_relations_by_kind: Readonly<Record<string, number>>;
  readonly latest_path_event_at: string | null;
  readonly warnings: readonly GraphHealthWarning[];
  readonly hint: string | null;
}

export interface GraphHealthService {
  getStatus(workspaceId: string): Promise<GraphHealthSnapshot>;
}

// invariant: every PATH_RELATION_* event that mutates path lifecycle/topology
// feeds latest_path_event_at, so a later dormancy/revival/consolidation-merge
// is not stale. PATH_RELATION_REJECTED is deliberately excluded: a refused
// candidate never became durable topology — it is a forensic refusal record,
// not graph activity.
// see also: packages/protocol/src/events/runtime-governance.ts PATH_RELATION_*.
const PATH_RELATION_EVENT_TYPES = [
  RuntimeGovernanceEventType.PATH_RELATION_CREATED,
  RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
  RuntimeGovernanceEventType.PATH_RELATION_REINFORCED,
  RuntimeGovernanceEventType.PATH_RELATION_WEAKENED,
  RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED,
  RuntimeGovernanceEventType.PATH_RELATION_RETIRED,
  RuntimeGovernanceEventType.PATH_RELATION_DORMANT,
  RuntimeGovernanceEventType.PATH_RELATION_REVIVED,
  RuntimeGovernanceEventType.PATH_RELATION_MERGED
] as const;

const SPARSE_GRAPH_HINT =
  "Path evidence is sparse; this is expected for a new install or workspace before recall/report and Garden path activity.";

// invariant: graph health reports the unified path plane only. memory_graph_edges
// is no longer counted here — no producer writes it and the table is retired.
// path_relations_by_kind groups active relations by constitution.relation_kind.
export function createGraphHealthService(deps: {
  readonly pathRelationRepo: Pick<PathRelationRepo, "findByWorkspace">;
  readonly eventLogRepo: Pick<EventLogRepo, "queryByWorkspaceAndType">;
}): GraphHealthService {
  return Object.freeze({
    getStatus: async (workspaceId: string): Promise<GraphHealthSnapshot> => {
      const [pathRelations, pathEventBatches] = await Promise.all([
        deps.pathRelationRepo.findByWorkspace(workspaceId),
        Promise.all(
          PATH_RELATION_EVENT_TYPES.map(
            async (eventType) => await deps.eventLogRepo.queryByWorkspaceAndType(workspaceId, eventType)
          )
        )
      ]);

      const activePathRelations = pathRelations.filter(isActivePathRelation);
      const byKind: Record<string, number> = {};
      for (const relation of activePathRelations) {
        const kind = relation.constitution.relation_kind;
        byKind[kind] = (byKind[kind] ?? 0) + 1;
      }

      const warnings: GraphHealthWarning[] = [];
      if (activePathRelations.length === 0) {
        warnings.push("path_relations_empty");
      }

      return Object.freeze({
        workspace_id: workspaceId,
        status: warnings.length === 0 ? "healthy" : "degraded",
        path_relations_total: activePathRelations.length,
        path_relations_by_kind: Object.freeze(byKind),
        latest_path_event_at: latestEventCreatedAt(pathEventBatches.flat()),
        warnings: Object.freeze(warnings),
        hint: warnings.length === 0 ? null : SPARSE_GRAPH_HINT
      });
    }
  });
}

function isActivePathRelation(relation: Readonly<PathRelation>): boolean {
  return isPathActiveForRecall(relation.lifecycle.status);
}

export function createEmptyGraphHealthSnapshot(workspaceId: string): GraphHealthSnapshot {
  const warnings: readonly GraphHealthWarning[] = ["path_relations_empty"];
  return Object.freeze({
    workspace_id: workspaceId,
    status: "degraded",
    path_relations_total: 0,
    path_relations_by_kind: Object.freeze({}),
    latest_path_event_at: null,
    warnings: Object.freeze(warnings),
    hint: SPARSE_GRAPH_HINT
  });
}

function latestEventCreatedAt(events: readonly Readonly<EventLogEntry>[]): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if (latest === null || event.created_at > latest) {
      latest = event.created_at;
    }
  }
  return latest;
}
