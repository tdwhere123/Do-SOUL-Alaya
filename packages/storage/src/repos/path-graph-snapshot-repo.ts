import { PathGraphSnapshotSchema, type PathGraphSnapshot } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

type PathGraphSnapshotMetrics = Omit<PathGraphSnapshot, "snapshot_id" | "workspace_id" | "snapshot_at">;

interface PathGraphSnapshotRow {
  readonly snapshot_id: string;
  readonly workspace_id: string;
  readonly metrics_json: string;
  readonly snapshot_at: string;
}

export interface PathGraphSnapshotRepo {
  create(snapshot: PathGraphSnapshot): Promise<Readonly<PathGraphSnapshot>>;
  findLatest(workspaceId: string): Promise<Readonly<PathGraphSnapshot> | null>;
  findHistory(workspaceId: string, limit: number): Promise<readonly Readonly<PathGraphSnapshot>[]>;
  deleteOlderThan(workspaceId: string, beforeDate: string): Promise<number>;
}

const PATH_GRAPH_SNAPSHOT_SELECT_COLUMNS = `
      snapshot_id,
      workspace_id,
      metrics_json,
      snapshot_at
`;

export class SqlitePathGraphSnapshotRepo implements PathGraphSnapshotRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findLatestStatement;
  private readonly findHistoryStatement;
  private readonly deleteOlderThanStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO path_graph_snapshots (
        snapshot_id,
        workspace_id,
        metrics_json,
        snapshot_at
      ) VALUES (?, ?, ?, ?)
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${PATH_GRAPH_SNAPSHOT_SELECT_COLUMNS}
      FROM path_graph_snapshots
      WHERE snapshot_id = ?
      LIMIT 1
    `);

    this.findLatestStatement = db.connection.prepare(`
      SELECT${PATH_GRAPH_SNAPSHOT_SELECT_COLUMNS}
      FROM path_graph_snapshots
      WHERE workspace_id = ?
      ORDER BY snapshot_at DESC, snapshot_id DESC
      LIMIT 1
    `);

    this.findHistoryStatement = db.connection.prepare(`
      SELECT${PATH_GRAPH_SNAPSHOT_SELECT_COLUMNS}
      FROM path_graph_snapshots
      WHERE workspace_id = ?
      ORDER BY snapshot_at DESC, snapshot_id DESC
      LIMIT ?
    `);

    this.deleteOlderThanStatement = db.connection.prepare(`
      DELETE FROM path_graph_snapshots
      WHERE workspace_id = ?
        AND snapshot_at < ?
    `);
  }

  public async create(snapshot: PathGraphSnapshot): Promise<Readonly<PathGraphSnapshot>> {
    const parsedSnapshot = parsePathGraphSnapshot(snapshot);

    try {
      this.createStatement.run(
        parsedSnapshot.snapshot_id,
        parsedSnapshot.workspace_id,
        JSON.stringify(extractMetrics(parsedSnapshot)),
        parsedSnapshot.snapshot_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to insert path graph snapshot ${parsedSnapshot.snapshot_id}.`,
        error
      );
    }

    const persistedSnapshot = await this.findById(parsedSnapshot.snapshot_id);
    if (persistedSnapshot === null) {
      throw new StorageError(
        "QUERY_FAILED",
        `Inserted path graph snapshot ${parsedSnapshot.snapshot_id} could not be reloaded.`
      );
    }

    return persistedSnapshot;
  }

  public async findLatest(workspaceId: string): Promise<Readonly<PathGraphSnapshot> | null> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = this.findLatestStatement.get(parsedWorkspaceId) as PathGraphSnapshotRow | undefined;
      return row === undefined ? null : parsePathGraphSnapshotRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load latest path graph snapshot for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findHistory(
    workspaceId: string,
    limit: number
  ): Promise<readonly Readonly<PathGraphSnapshot>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedLimit = parseLimit(limit);

    if (parsedLimit === 0) {
      return [];
    }

    try {
      const rows = this.findHistoryStatement.all(parsedWorkspaceId, parsedLimit) as PathGraphSnapshotRow[];
      return deepFreeze(rows.map((row) => parsePathGraphSnapshotRow(row)));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load path graph snapshot history for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async deleteOlderThan(workspaceId: string, beforeDate: string): Promise<number> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedBeforeDate = parseTimestamp(beforeDate);

    try {
      return this.deleteOlderThanStatement.run(parsedWorkspaceId, parsedBeforeDate).changes;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to delete old path graph snapshots for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  private async findById(snapshotId: string): Promise<Readonly<PathGraphSnapshot> | null> {
    const parsedSnapshotId = parseNonEmptyString(snapshotId, "snapshot id");

    try {
      const row = this.findByIdStatement.get(parsedSnapshotId) as PathGraphSnapshotRow | undefined;
      return row === undefined ? null : parsePathGraphSnapshotRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load path graph snapshot ${parsedSnapshotId}.`,
        error
      );
    }
  }
}

function extractMetrics(snapshot: PathGraphSnapshot): PathGraphSnapshotMetrics {
  return {
    total_active_paths: snapshot.total_active_paths,
    total_retired_paths: snapshot.total_retired_paths,
    strength_distribution: snapshot.strength_distribution,
    stability_distribution: snapshot.stability_distribution,
    governance_distribution: snapshot.governance_distribution,
    connectivity: snapshot.connectivity,
    paths_reinforced_since_last: snapshot.paths_reinforced_since_last,
    paths_weakened_since_last: snapshot.paths_weakened_since_last,
    paths_retired_since_last: snapshot.paths_retired_since_last,
    paths_created_since_last: snapshot.paths_created_since_last
  };
}

function parsePathGraphSnapshot(value: PathGraphSnapshot): Readonly<PathGraphSnapshot> {
  try {
    return deepFreeze(PathGraphSnapshotSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate path graph snapshot.", error);
  }
}

function parsePathGraphSnapshotRow(row: PathGraphSnapshotRow): Readonly<PathGraphSnapshot> {
  let metrics: unknown;

  try {
    metrics = JSON.parse(row.metrics_json);
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Failed to parse path graph snapshot metrics_json.",
      error
    );
  }

  return parsePathGraphSnapshot({
    snapshot_id: parseNonEmptyString(row.snapshot_id, "snapshot id"),
    workspace_id: parseNonEmptyString(row.workspace_id, "workspace id"),
    snapshot_at: parseTimestamp(row.snapshot_at),
    ...(metrics as PathGraphSnapshotMetrics)
  });
}

function parseLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate history limit.");
  }

  return limit;
}
