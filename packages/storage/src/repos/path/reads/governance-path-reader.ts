import { PathRelationSchema, type PathRelation } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { readTemporalSelectionState } from "../../../sqlite/temporal-projection-selection-state.js";
import { parsePathRelationRow, type PathRelationRow } from "../mappers/path-relation-rows.js";

export type GovernancePathReadInput = Readonly<{
  workspaceId: string;
  asOf: string;
  afterPathId: string | null;
  limit: number;
  byteLimit: number;
}>;

export type GovernancePathReadPage = Readonly<{
  rows: readonly Readonly<PathRelation>[];
  rowsRead: number;
  bytesRead: number;
  truncated: boolean;
  committedThrough: string | null;
  unavailable: boolean;
  temporalUncertain: boolean;
}>;

const LEGACY_BYTES = ["anchors_json", "constitution_json", "effect_vector_json", "plasticity_state_json",
  "lifecycle_json", "legitimacy_json", "created_at", "updated_at", "workspace_id", "path_id"]
  .map((column) => `length(CAST(${column} AS BLOB))`).join(" + ");

export class SqliteGovernancePathReader {
  public constructor(private readonly database: StorageDatabase) {}

  public prepareIndex(): void {
    this.database.connection.exec(GOVERNANCE_PATH_INDEX_SQL);
  }

  public read(input: GovernancePathReadInput): GovernancePathReadPage {
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 ||
        !Number.isSafeInteger(input.byteLimit) || input.byteLimit < 0 ||
        !Number.isFinite(Date.parse(input.asOf))) throw new Error("invalid bounded governance read");
    const rows: Readonly<PathRelation>[] = [];
    let rowsRead = 0;
    let bytesRead = 0;
    let committedThrough = input.afterPathId;
    let temporalUncertain = false;
    const page = (truncated: boolean, unavailable = false): GovernancePathReadPage =>
      ({ rows, rowsRead, bytesRead, truncated, committedThrough, unavailable, temporalUncertain });
    if (input.limit === 0 || input.byteLimit < 1024) return page(true);
    try {
      rowsRead += 1;
      const state = this.database.connection.prepare(`SELECT temporal_projection_selected AS selected,
        CASE WHEN length(CAST(active_projection_generation AS BLOB)) <= 512 THEN active_projection_generation END AS generation,
        CASE WHEN length(CAST(active_as_of AS BLOB)) <= 64 THEN active_as_of END AS as_of,
        CASE WHEN length(CAST(status AS BLOB)) <= 32 THEN status END AS status,
        COALESCE(length(CAST(selection_id AS BLOB)),0) + COALESCE(length(CAST(selected_at AS BLOB)),0)
          + COALESCE(length(CAST(active_projection_generation AS BLOB)),0) AS selection_bytes,
        projection_refresh_required AS refresh FROM temporal_schema_state WHERE state_id = 1`).get() as
        { selected: number; generation: string | null; as_of: string | null; status: string; refresh: number; selection_bytes: number } | undefined;
      bytesRead += state === undefined ? 0 : Buffer.byteLength(JSON.stringify(state), "utf8");
      if (state === undefined) return page(true, true);
      if (rowsRead >= input.limit || state.selection_bytes + 512 > input.byteLimit - bytesRead) return page(true);
      rowsRead += 1;
      const selection = readTemporalSelectionState(this.database.connection);
      bytesRead += Buffer.byteLength(JSON.stringify(selection), "utf8");
      if (selection.selectionRequired && !selection.selected) return page(true, true);
      const generation = selection.selected ? state.generation : null;
      if (selection.selected) {
        if (generation === null || state.as_of !== input.asOf || state.status !== "ready" || state.refresh !== 0 || rowsRead >= input.limit) {
          temporalUncertain = true;
          return page(true, true);
        }
        rowsRead += 1;
        const verified = this.database.connection.prepare(`SELECT 1 AS valid FROM temporal_projection_generations g
          JOIN temporal_schema_state s ON s.state_id = 1
          WHERE g.generation = ? AND g.status = 'verified' AND g.verified_at IS NOT NULL
          AND g.as_of = ? AND g.history_digest = s.history_digest
          AND g.assertion_schema_generation = s.assertion_schema_generation
          AND g.assertion_event_contract_generation = s.assertion_event_contract_generation
          AND g.projection_schema_generation = s.projection_schema_generation
          AND g.projection_policy_id = s.projection_policy_id
          AND g.projection_policy_sha256 = s.projection_policy_sha256
          AND g.projection_count = s.projection_count AND g.projection_digest = s.projection_digest`).get(generation, input.asOf);
        if (verified === undefined) return page(true, true);
      }
      while (rowsRead < input.limit) {
        if (input.byteLimit - bytesRead < 1024) return page(true);
        const parameters = generation === null
          ? [input.workspaceId, committedThrough ?? ""]
          : [generation, input.workspaceId, committedThrough ?? ""];
        const where = generation === null ? "workspace_id = ? AND path_id > ?" : "generation = ? AND workspace_id = ? AND path_id > ?";
        const table = generation === null ? "path_relations INDEXED BY idx_governance_paths_page"
          : "relation_path_projections INDEXED BY idx_governance_projection_page";
        rowsRead += 1;
        const descriptor = this.database.connection.prepare(`SELECT
          CASE WHEN length(CAST(path_id AS BLOB)) <= 512 THEN path_id END AS path_id,
          ${generation === null ? LEGACY_BYTES : "length(CAST(projection_json AS BLOB))"} AS bytes
          FROM ${table} WHERE ${where} ORDER BY path_id LIMIT 1`).get(...parameters) as
          { path_id: string | null; bytes: number } | undefined;
        if (descriptor === undefined) return page(false);
        bytesRead += Buffer.byteLength(JSON.stringify(descriptor), "utf8");
        if (descriptor.path_id === null) return page(true, true);
        if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0) return page(true, true);
        if (descriptor.bytes * 6 + 4096 > input.byteLimit - bytesRead || rowsRead >= input.limit) return page(true);
        rowsRead += 1;
        const row = generation === null
          ? this.database.connection.prepare("SELECT * FROM path_relations WHERE path_id = ? AND workspace_id = ?")
            .get(descriptor.path_id, input.workspaceId) as PathRelationRow
          : this.database.connection.prepare("SELECT projection_json FROM relation_path_projections WHERE generation = ? AND path_id = ? AND workspace_id = ?")
            .get(generation, descriptor.path_id, input.workspaceId) as { projection_json: string };
        const path = generation === null ? parsePathRelationRow(row as PathRelationRow)
          : PathRelationSchema.parse(JSON.parse((row as { projection_json: string }).projection_json));
        bytesRead += Math.max(descriptor.bytes, Buffer.byteLength(JSON.stringify(path), "utf8"));
        if (Date.parse(path.updated_at) > Date.parse(input.asOf)) temporalUncertain = true;
        else if (Date.parse(path.created_at) <= Date.parse(input.asOf)) rows.push(path);
        committedThrough = descriptor.path_id;
      }
      return page(true);
    } catch {
      return page(true, true);
    }
  }
}

export const GOVERNANCE_PATH_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_governance_paths_page
  ON path_relations(workspace_id, path_id);
  CREATE INDEX IF NOT EXISTS idx_governance_projection_page
  ON relation_path_projections(generation, workspace_id, path_id);`;
