import { HostOccurrenceInventorySchema, SourceRepresentationSchema, SourceScopeClassSchema,
  type HostOccurrence } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../../sqlite/db.js";
import { CURRENT_SOURCE_RECORD_ORDER, readSourceProjectionDependencies } from "../field/source-representation-read.js";
import { HostSessionLedger, type HostSessionRound } from "./host-session-ledger.js";

// Must stay identical to the expression of idx_garden_tasks_statement_session_container.
const CONTAINER_KEY = "(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.container_key') END)";

/** A current, fully available admitted root with its host message occurrences. */
export type StatementSessionRoot = Readonly<{
  workspace_id: string; root_id: string; source_id: string; source_version: string; content_digest: string;
  recorded_at: string; content: string; occurrences: readonly HostOccurrence[];
}>;
export type StatementSessionRootRead = Readonly<{ status: "available"; root: StatementSessionRoot }> |
  Readonly<{ status: "unavailable"; reason: string }>;

/** Read-only facts for statement sessions: a container's round roots, root bodies and the last planned chunk. */
export class GardenStatementSessionSources {
  private readonly ledger: HostSessionLedger;
  public constructor(private readonly connection: SqliteConnection) {
    this.ledger = new HostSessionLedger(connection);
  }

  /** Round roots in logical order, limited to one page. */
  public roundPage(workspaceId: string, containerKey: string, after: number, limit: number): readonly HostSessionRound[] {
    return this.ledger.roundPage(workspaceId, containerKey, after, limit);
  }

  public roundForRoot(workspaceId: string, containerKey: string, rootId: string): HostSessionRound | null {
    return this.ledger.roundForRoot(workspaceId, containerKey, rootId);
  }

  public roundAt(workspaceId: string, containerKey: string, index: number): HostSessionRound | null {
    const round = this.ledger.roundPage(workspaceId, containerKey, index - 1, 1)[0];
    return round?.round_index === index ? round : null;
  }

  /** Skip known raw-only gaps in SQL while finding the bounded model-visible suffix. */
  public contextPage(workspaceId: string, containerKey: string, before: number, limit: number): readonly HostSessionRound[] {
    return this.connection.prepare(`SELECT r.round_index, r.root_id,
      (SELECT run_id FROM host_session_messages m WHERE m.workspace_id = r.workspace_id
        AND m.container_key = r.container_key AND m.round_index = r.round_index ORDER BY m.position LIMIT 1) AS run_id
      FROM host_session_rounds r JOIN source_records s ON s.workspace_id = r.workspace_id AND s.record_id = r.root_id
      JOIN source_host_inventories i ON i.workspace_id = r.workspace_id AND i.record_id = r.root_id
      WHERE r.workspace_id = ? AND r.container_key = ? AND r.round_index < ? AND r.state = 'done'
        AND s.source_body IS NOT NULL AND json_valid(i.canonical_inventory)
        AND NOT EXISTS (SELECT 1 FROM projection_erase_barriers b WHERE b.workspace_id = r.workspace_id
          AND b.subject_kind = 'source_record' AND b.subject_id = r.root_id)
        AND NOT EXISTS (SELECT 1 FROM json_each(i.canonical_inventory, '$.occurrences') o
          WHERE COALESCE(json_type(o.value, '$.role'), '') != 'text')
      ORDER BY r.round_index DESC LIMIT ?`).all(workspaceId, containerKey, before, limit) as HostSessionRound[];
  }

  public planningCursor(workspaceId: string, containerKey: string): Readonly<{ round_index: number; occurrence_end: number }> | null {
    return (this.connection.prepare(`SELECT round_index, occurrence_end FROM host_session_planning
      WHERE workspace_id = ? AND container_key = ?`).get(workspaceId, containerKey) as
      { round_index: number; occurrence_end: number } | undefined) ?? null;
  }

  public savePlanningCursor(workspaceId: string, containerKey: string, index: number, end: number): void {
    this.connection.prepare(`INSERT INTO host_session_planning VALUES (?, ?, ?, ?)
      ON CONFLICT (workspace_id, container_key) DO UPDATE SET round_index = excluded.round_index,
        occurrence_end = excluded.occurrence_end`).run(workspaceId, containerKey, index, end);
  }

  public transaction<T>(work: () => T): T { return this.ledger.transaction(work); }

  /** Payload of the container's highest planned chunk, or null before the first chunk closes. */
  public lastChunkPayload(workspaceId: string, containerKey: string): unknown {
    const row = this.connection.prepare(`SELECT payload_json FROM garden_tasks
      WHERE kind = 'source_statement_session' AND workspace_id = ? AND ${CONTAINER_KEY} = ?
      ORDER BY (CASE WHEN json_valid(payload_json) THEN CAST(json_extract(payload_json, '$.chunk_index') AS INTEGER) END) DESC,
        id DESC LIMIT 1`)
      .get(workspaceId, containerKey) as { payload_json: string } | undefined;
    return row === undefined ? null : JSON.parse(row.payload_json) as unknown;
  }

  /** A statement source must be current, retained, unerased with available projection dependencies,
   * and carry a captured host inventory; anything else is unavailable, never an empty session.
   */
  public root(workspaceId: string, rootId: string): StatementSessionRootRead {
    const row = this.connection.prepare(`SELECT record_id, source_id, source_version, content_digest, recorded_at, scope_class,
        source_representation_json, source_body,
        (SELECT record_id FROM source_records INDEXED BY idx_source_records_current
         WHERE workspace_id = origin.workspace_id AND source_id = origin.source_id
         ORDER BY ${CURRENT_SOURCE_RECORD_ORDER} LIMIT 1) AS current_identity,
        EXISTS (SELECT 1 FROM projection_erase_barriers WHERE workspace_id = origin.workspace_id
          AND subject_kind = 'source_record' AND subject_id = origin.record_id) AS erased,
        (SELECT canonical_inventory FROM source_host_inventories
         WHERE workspace_id = origin.workspace_id AND record_id = origin.record_id) AS inventory
      FROM source_records origin WHERE workspace_id = ? AND record_id = ?`).get(workspaceId, rootId) as {
        record_id: string; source_id: string; source_version: string; content_digest: string; recorded_at: string;
        scope_class: unknown;
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
      source_version: row.source_version, content_digest: row.content_digest, recorded_at: row.recorded_at,
      content: row.source_body,
      occurrences: inventory.data.occurrences } };
  }
}

function unavailable(reason: string): StatementSessionRootRead {
  return { status: "unavailable", reason };
}
