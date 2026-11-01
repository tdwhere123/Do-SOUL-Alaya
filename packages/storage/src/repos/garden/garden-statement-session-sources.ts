import { HostOccurrenceInventorySchema, SourceRepresentationSchema, SourceScopeClassSchema,
  type HostOccurrence } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../../sqlite/db.js";
import { CURRENT_SOURCE_RECORD_ORDER, readSourceProjectionDependencies } from "../field/source-representation-read.js";

// Must stay identical to the expression of idx_garden_tasks_statement_session_run.
const RUN_ID = "(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.run_id') END)";

/** `newest_turn` is the run's newest post-turn rowid, the sweep checkpoint. */
export type StatementSessionIdleRun = Readonly<{ workspace_id: string; run_id: string; newest_turn: number }>;
export type StatementSessionTurn = Readonly<{
  task_id: string; root_id: string | null; created_at: string; source_observed_at: string | null;
}>;
/** A current, fully available admitted root with its host message occurrences. */
export type StatementSessionRoot = Readonly<{
  workspace_id: string; root_id: string; source_id: string; source_version: string; content_digest: string;
  content: string; occurrences: readonly HostOccurrence[];
}>;
export type StatementSessionRootRead = Readonly<{ status: "available"; root: StatementSessionRoot }> |
  Readonly<{ status: "unavailable"; reason: string }>;

/** Read-only facts for statement sessions: run turn inventory, root bodies and the last planned chunk. */
export class GardenStatementSessionSources {
  public constructor(private readonly connection: SqliteConnection) {}

  /** Daemon admission order; a caller turn index is untrusted for ordering and would let late turns sort behind the cursor. */
  public turns(workspaceId: string, runId: string): readonly StatementSessionTurn[] {
    return (this.connection.prepare(`SELECT id AS task_id, created_at,
        json_extract(payload_json, '$.admitted_source_root_id') AS root_id,
        json_extract(payload_json, '$.source_observed_at') AS source_observed_at
      FROM garden_tasks WHERE kind = 'post_turn_extract' AND workspace_id = ? AND ${RUN_ID} = ?
      ORDER BY created_at, rowid`)
      .all(workspaceId, runId) as { task_id: string; created_at: string; root_id: unknown; source_observed_at: unknown }[])
      .map(row => ({ task_id: row.task_id, created_at: row.created_at,
        root_id: typeof row.root_id === "string" && row.root_id.length > 0 ? row.root_id : null,
        source_observed_at: typeof row.source_observed_at === "string" ? row.source_observed_at : null }));
  }

  /** Payload of the run's highest planned chunk, or null before the first chunk closes. */
  public lastChunkPayload(workspaceId: string, runId: string): unknown {
    const row = this.connection.prepare(`SELECT payload_json FROM garden_tasks
      WHERE kind = 'source_statement_session' AND workspace_id = ? AND ${RUN_ID} = ?
      ORDER BY CAST(json_extract(payload_json, '$.chunk_index') AS INTEGER) DESC, id DESC LIMIT 1`)
      .get(workspaceId, runId) as { payload_json: string } | undefined;
    return row === undefined ? null : JSON.parse(row.payload_json) as unknown;
  }

  /** Idle runs with a turn admitted after their last tail sweep, freshest first so dead runs never starve new ones. */
  public idleOpenRuns(idleBefore: string, admittedSince: string, limit: number): readonly StatementSessionIdleRun[] {
    return this.connection.prepare(`WITH runs AS (
        SELECT workspace_id, ${RUN_ID} AS run_id, MAX(created_at) AS newest, MAX(rowid) AS newest_turn FROM garden_tasks
        WHERE kind = 'post_turn_extract' AND created_at >= ? AND ${RUN_ID} IS NOT NULL
        GROUP BY workspace_id, run_id HAVING newest <= ?
      )
      SELECT runs.workspace_id, runs.run_id, runs.newest_turn FROM runs
      LEFT JOIN statement_session_sweeps AS sweep ON sweep.workspace_id = runs.workspace_id AND sweep.run_id = runs.run_id
      WHERE sweep.swept_through IS NULL OR sweep.swept_through < runs.newest_turn
      ORDER BY runs.newest DESC, runs.workspace_id, runs.run_id LIMIT ?`)
      .all(admittedSince, idleBefore, limit) as StatementSessionIdleRun[];
  }

  /** Records that the tail through `newestTurn` was examined, whether or not it formed a request. */
  public markSwept(workspaceId: string, runId: string, newestTurn: number): void {
    this.connection.prepare(`INSERT INTO statement_session_sweeps (workspace_id, run_id, swept_through) VALUES (?, ?, ?)
      ON CONFLICT (workspace_id, run_id) DO UPDATE SET swept_through = MAX(swept_through, excluded.swept_through)`)
      .run(workspaceId, runId, newestTurn);
  }

  /** A statement source must be current, retained, unerased with available projection dependencies,
   * and carry a captured host inventory; anything else is unavailable, never an empty session.
   */
  public root(workspaceId: string, rootId: string): StatementSessionRootRead {
    const row = this.connection.prepare(`SELECT record_id, source_id, source_version, content_digest, scope_class,
        source_representation_json, source_body,
        (SELECT record_id FROM source_records INDEXED BY idx_source_records_current
         WHERE workspace_id = origin.workspace_id AND source_id = origin.source_id
         ORDER BY ${CURRENT_SOURCE_RECORD_ORDER} LIMIT 1) AS current_identity,
        EXISTS (SELECT 1 FROM projection_erase_barriers WHERE workspace_id = origin.workspace_id
          AND subject_kind = 'source_record' AND subject_id = origin.record_id) AS erased,
        (SELECT canonical_inventory FROM source_host_inventories
         WHERE workspace_id = origin.workspace_id AND record_id = origin.record_id) AS inventory
      FROM source_records origin WHERE workspace_id = ? AND record_id = ?`).get(workspaceId, rootId) as {
        record_id: string; source_id: string; source_version: string; content_digest: string; scope_class: unknown;
        source_representation_json: string | null; source_body: string | null; current_identity: string | null;
        erased: number; inventory: string | null } | undefined;
    if (row === undefined || row.source_body === null || row.erased === 1) return unavailable("retained source unavailable");
    if (row.current_identity !== row.record_id) return unavailable("source binding superseded");
    const representation = row.source_representation_json === null ? undefined
      : SourceRepresentationSchema.parse(JSON.parse(row.source_representation_json));
    if (!readSourceProjectionDependencies({ connection: this.connection }, { workspace_id: workspaceId,
      scope_class: row.scope_class == null ? null : SourceScopeClassSchema.parse(row.scope_class),
      source_representation: representation }, CURRENT_SOURCE_RECORD_ORDER).available) {
      return unavailable("source projection dependency unavailable");
    }
    const inventory = row.inventory === null ? null : HostOccurrenceInventorySchema.safeParse(JSON.parse(row.inventory));
    if (inventory === null || !inventory.success) return unavailable("host message structure unavailable");
    return { status: "available", root: { workspace_id: workspaceId, root_id: row.record_id, source_id: row.source_id,
      source_version: row.source_version, content_digest: row.content_digest, content: row.source_body,
      occurrences: inventory.data.occurrences } };
  }
}

function unavailable(reason: string): StatementSessionRootRead {
  return { status: "unavailable", reason };
}
