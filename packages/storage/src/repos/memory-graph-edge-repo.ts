import {
  MEMORY_GRAPH_EDGE_RECALL_WEIGHTS,
  MemoryGraphEdgeSchema,
  MemoryGraphEdgeTypeSchema,
  type MemoryGraphEdge,
  type MemoryGraphEdgeTypeValue
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

const MEMORY_GRAPH_EDGE_LIST_LIMIT = 200;

// SQL `CASE edge_type WHEN ... THEN ...` derived from
// MEMORY_GRAPH_EDGE_RECALL_WEIGHTS. Adding a new MemoryGraphEdgeType value
// without a weight entry compiles cleanly but contributes 0 here, matching
// the documented behavior of the weight map.
const WEIGHTED_INBOUND_CASE_SQL = (() => {
  const arms = Object.entries(MEMORY_GRAPH_EDGE_RECALL_WEIGHTS)
    .filter(([, weight]) => weight !== 0)
    .map(([edgeType, weight]) => `WHEN '${edgeType}' THEN ${weight}`);
  return `CASE edge_type ${arms.join(" ")} ELSE 0 END`;
})();

export interface MemoryGraphEdgeRepo {
  // invariant: synchronous so the row insert can be wrapped together with
  // its `soul.graph.edge_created` audit event inside one SQLite transaction
  // via EventPublisher.appendManyWithMutation.
  create(edge: Readonly<MemoryGraphEdge>): Readonly<MemoryGraphEdge>;
  findById(edgeId: string): Promise<Readonly<MemoryGraphEdge> | null>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<MemoryGraphEdge>[]>;
  findByMemoryId(
    memoryId: string,
    workspaceId: string,
    edgeTypes?: readonly MemoryGraphEdgeTypeValue[]
  ): Promise<readonly Readonly<MemoryGraphEdge>[]>;
  findBySourceAndTarget(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string
  ): Promise<Readonly<MemoryGraphEdge> | null>;
  /** @deprecated use `countInboundEdgesWeighted`. Retained for diagnostic
   * surfaces that still need a raw supports-only count. */
  countInboundSupports(memoryId: string, workspaceId: string): Promise<number>;
  // Aggregates inbound edges into a single signed graph-support score using
  // MEMORY_GRAPH_EDGE_RECALL_WEIGHTS. The caller normalizes the result.
  countInboundEdgesWeighted(memoryId: string, workspaceId: string): Promise<number>;
  countInboundRecalls(memoryId: string, workspaceId: string): Promise<number>;
  delete(edgeId: string): Promise<void>;
}

interface MemoryGraphEdgeRow {
  readonly edge_id: string;
  readonly source_memory_id: string;
  readonly target_memory_id: string;
  readonly edge_type: MemoryGraphEdgeTypeValue;
  readonly workspace_id: string;
  readonly created_at: string;
}

export class SqliteMemoryGraphEdgeRepo implements MemoryGraphEdgeRepo {
  public constructor(private readonly db: StorageDatabase) {}

  public create(edge: Readonly<MemoryGraphEdge>): Readonly<MemoryGraphEdge> {
    const parsed = parseEdge(edge);

    try {
      this.db.connection
        .prepare(
          `INSERT INTO memory_graph_edges (
            edge_id,
            source_memory_id,
            target_memory_id,
            edge_type,
            workspace_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          parsed.edge_id,
          parsed.source_memory_id,
          parsed.target_memory_id,
          parsed.edge_type,
          parsed.workspace_id,
          parsed.created_at
        );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create memory graph edge ${parsed.edge_id}.`, error);
    }

    return parsed;
  }

  public async findById(edgeId: string): Promise<Readonly<MemoryGraphEdge> | null> {
    const parsedEdgeId = parseNonEmptyString(edgeId, "edge id");

    try {
      const row = this.db.connection
        .prepare(
          `SELECT edge_id, source_memory_id, target_memory_id, edge_type, workspace_id, created_at
           FROM memory_graph_edges
           WHERE edge_id = ?
           LIMIT 1`
        )
        .get(parsedEdgeId) as MemoryGraphEdgeRow | undefined;

      return row === undefined ? null : parseRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load memory graph edge ${parsedEdgeId}.`, error);
    }
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<MemoryGraphEdge>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.db.connection
        .prepare(
          `SELECT edge_id, source_memory_id, target_memory_id, edge_type, workspace_id, created_at
           FROM memory_graph_edges
           WHERE workspace_id = ?
           ORDER BY created_at ASC, edge_id ASC`
        )
        .all(parsedWorkspaceId) as MemoryGraphEdgeRow[];

      return Object.freeze(rows.map((row) => parseRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory graph edges for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findByMemoryId(
    memoryId: string,
    workspaceId: string,
    edgeTypes?: readonly MemoryGraphEdgeTypeValue[]
  ): Promise<readonly Readonly<MemoryGraphEdge>[]> {
    const parsedMemoryId = parseNonEmptyString(memoryId, "memory id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedEdgeTypes =
      edgeTypes?.map((edgeType) => MemoryGraphEdgeTypeSchema.parse(edgeType)) ?? [];

    try {
      const rows =
        parsedEdgeTypes.length === 0
          ? (this.db.connection
              .prepare(
                `SELECT edge_id, source_memory_id, target_memory_id, edge_type, workspace_id, created_at
                 FROM memory_graph_edges
                 WHERE workspace_id = ?
                   AND (source_memory_id = ? OR target_memory_id = ?)
                 ORDER BY created_at ASC, edge_id ASC
                 LIMIT ${MEMORY_GRAPH_EDGE_LIST_LIMIT}`
              )
              .all(parsedWorkspaceId, parsedMemoryId, parsedMemoryId) as MemoryGraphEdgeRow[])
          : (this.db.connection
              .prepare(
                `SELECT edge_id, source_memory_id, target_memory_id, edge_type, workspace_id, created_at
                 FROM memory_graph_edges
                 WHERE workspace_id = ?
                   AND (source_memory_id = ? OR target_memory_id = ?)
                   AND edge_type IN (${parsedEdgeTypes.map(() => "?").join(", ")})
                 ORDER BY created_at ASC, edge_id ASC
                 LIMIT ${MEMORY_GRAPH_EDGE_LIST_LIMIT}`
              )
              .all(parsedWorkspaceId, parsedMemoryId, parsedMemoryId, ...parsedEdgeTypes) as MemoryGraphEdgeRow[]);

      return Object.freeze(rows.map((row) => parseRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory graph edges for memory ${parsedMemoryId}.`,
        error
      );
    }
  }

  public async findBySourceAndTarget(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string
  ): Promise<Readonly<MemoryGraphEdge> | null> {
    const parsedSourceId = parseNonEmptyString(sourceMemoryId, "source memory id");
    const parsedTargetId = parseNonEmptyString(targetMemoryId, "target memory id");
    const parsedEdgeType = MemoryGraphEdgeTypeSchema.parse(edgeType);
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = this.db.connection
        .prepare(
          `SELECT edge_id, source_memory_id, target_memory_id, edge_type, workspace_id, created_at
           FROM memory_graph_edges
           WHERE source_memory_id = ? AND target_memory_id = ? AND edge_type = ? AND workspace_id = ?
           LIMIT 1`
        )
        .get(parsedSourceId, parsedTargetId, parsedEdgeType, parsedWorkspaceId) as MemoryGraphEdgeRow | undefined;

      return row === undefined ? null : parseRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load memory graph edge ${parsedSourceId} -> ${parsedTargetId}.`,
        error
      );
    }
  }

  public async countInboundSupports(memoryId: string, workspaceId: string): Promise<number> {
    const parsedMemoryId = parseNonEmptyString(memoryId, "memory id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = this.db.connection
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_graph_edges
           WHERE target_memory_id = ? AND workspace_id = ? AND edge_type = 'supports'`
        )
        .get(parsedMemoryId, parsedWorkspaceId) as { readonly count: number } | undefined;

      return row?.count ?? 0;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count inbound supports for memory ${parsedMemoryId}.`,
        error
      );
    }
  }

  public async countInboundEdgesWeighted(memoryId: string, workspaceId: string): Promise<number> {
    const parsedMemoryId = parseNonEmptyString(memoryId, "memory id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      // SQL derived from MEMORY_GRAPH_EDGE_RECALL_WEIGHTS; see WEIGHTED_INBOUND_CASE_SQL.
      const row = this.db.connection
        .prepare(
          `SELECT COALESCE(SUM(${WEIGHTED_INBOUND_CASE_SQL}), 0) AS weight
           FROM memory_graph_edges
           WHERE target_memory_id = ? AND workspace_id = ?`
        )
        .get(parsedMemoryId, parsedWorkspaceId) as { readonly weight: number } | undefined;

      return row?.weight ?? 0;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to compute weighted inbound edges for memory ${parsedMemoryId}.`,
        error
      );
    }
  }

  public async countInboundRecalls(memoryId: string, workspaceId: string): Promise<number> {
    const parsedMemoryId = parseNonEmptyString(memoryId, "memory id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = this.db.connection
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_graph_edges
           WHERE target_memory_id = ? AND workspace_id = ? AND edge_type = 'recalls'`
        )
        .get(parsedMemoryId, parsedWorkspaceId) as { readonly count: number } | undefined;

      return row?.count ?? 0;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count inbound recalls for memory ${parsedMemoryId}.`,
        error
      );
    }
  }

  public async delete(edgeId: string): Promise<void> {
    const parsedEdgeId = parseNonEmptyString(edgeId, "edge id");

    try {
      this.db.connection.prepare("DELETE FROM memory_graph_edges WHERE edge_id = ?").run(parsedEdgeId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to delete memory graph edge ${parsedEdgeId}.`, error);
    }
  }
}

function parseEdge(edge: Readonly<MemoryGraphEdge>): Readonly<MemoryGraphEdge> {
  try {
    return deepFreeze(
      MemoryGraphEdgeSchema.parse({
        edge_id: parseNonEmptyString(edge.edge_id, "edge id"),
        source_memory_id: parseNonEmptyString(edge.source_memory_id, "source memory id"),
        target_memory_id: parseNonEmptyString(edge.target_memory_id, "target memory id"),
        edge_type: edge.edge_type,
        workspace_id: parseNonEmptyString(edge.workspace_id, "workspace id"),
        created_at: parseTimestamp(edge.created_at)
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate memory graph edge.", error);
  }
}

function parseRow(row: MemoryGraphEdgeRow): Readonly<MemoryGraphEdge> {
  try {
    return deepFreeze(MemoryGraphEdgeSchema.parse(row));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse memory graph edge row.", error);
  }
}
