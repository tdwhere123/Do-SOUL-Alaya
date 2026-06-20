import { GapRecordSchema, HandoffRecordSchema, type GapRecord, type HandoffRecord } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  parseGapRow,
  parseHandoffRow,
  type ExpiredObjectRow,
  type GapRecordRow,
  type HandoffRecordRow
} from "./handoff-gap-rows.js";

const INSERT_HANDOFF_RECORD_SQL = `INSERT INTO handoff_records (
            runtime_id,
            object_kind,
            task_surface_ref,
            expires_at,
            derived_from,
            retention_policy,
            handoff_kind,
            source_run_id,
            target_run_id,
            surface_id,
            ttl_ms,
            recurrence_runs,
            recurrence_surfaces,
            governance_impact,
            unresolved_age_ms,
            upgrade_candidate
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_GAP_RECORD_SQL = `INSERT INTO gap_records (
            runtime_id,
            object_kind,
            task_surface_ref,
            expires_at,
            derived_from,
            retention_policy,
            gap_kind,
            detected_in_run_id,
            surface_id,
            description,
            ttl_ms,
            recurrence_runs,
            recurrence_surfaces,
            governance_impact,
            unresolved_age_ms,
            upgrade_candidate
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// ---------------------------------------------------------------------------
// SqliteHandoffGapRepo
// ---------------------------------------------------------------------------

export class SqliteHandoffGapRepo {
  private readonly database: StorageDatabase;

  public constructor(database: StorageDatabase) {
    this.database = database;
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  public createHandoff(record: HandoffRecord): Readonly<HandoffRecord> {
    const parsed = parseHandoffRecordForCreate(record);

    try {
      insertHandoffRecord(this.database, parsed);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create handoff record ${parsed.runtime_id}.`,
        error
      );
    }

    return requirePersistedHandoff(parsed.runtime_id, this.findHandoffById(parsed.runtime_id));
  }

  public createGap(record: GapRecord): Readonly<GapRecord> {
    const parsed = parseGapRecordForCreate(record);

    try {
      insertGapRecord(this.database, parsed);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create gap record ${parsed.runtime_id}.`,
        error
      );
    }

    return requirePersistedGap(parsed.runtime_id, this.findGapById(parsed.runtime_id));
  }

  // -------------------------------------------------------------------------
  // Find by id
  // -------------------------------------------------------------------------

  public findHandoffById(id: string): Readonly<HandoffRecord> | null {
    try {
      const row = this.database.connection
        .prepare(
          `SELECT
            runtime_id, object_kind, task_surface_ref, expires_at, derived_from,
            retention_policy, handoff_kind, source_run_id, target_run_id, surface_id,
            ttl_ms, recurrence_runs, recurrence_surfaces, governance_impact,
            unresolved_age_ms, upgrade_candidate
          FROM handoff_records
          WHERE runtime_id = ?
          LIMIT 1`
        )
        .get(id) as HandoffRecordRow | undefined;

      return row === undefined ? null : parseHandoffRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load handoff record ${id}.`,
        error
      );
    }
  }

  public findGapById(id: string): Readonly<GapRecord> | null {
    try {
      const row = this.database.connection
        .prepare(
          `SELECT
            runtime_id, object_kind, task_surface_ref, expires_at, derived_from,
            retention_policy, gap_kind, detected_in_run_id, surface_id, description,
            ttl_ms, recurrence_runs, recurrence_surfaces, governance_impact,
            unresolved_age_ms, upgrade_candidate
          FROM gap_records
          WHERE runtime_id = ?
          LIMIT 1`
        )
        .get(id) as GapRecordRow | undefined;

      return row === undefined ? null : parseGapRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load gap record ${id}.`,
        error
      );
    }
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  public listAll(): ReadonlyArray<Readonly<HandoffRecord | GapRecord>> {
    try {
      const handoffRows = this.database.connection
        .prepare(
          `SELECT
            runtime_id, object_kind, task_surface_ref, expires_at, derived_from,
            retention_policy, handoff_kind, source_run_id, target_run_id, surface_id,
            ttl_ms, recurrence_runs, recurrence_surfaces, governance_impact,
            unresolved_age_ms, upgrade_candidate
          FROM handoff_records
          ORDER BY runtime_id ASC`
        )
        .all() as HandoffRecordRow[];

      const gapRows = this.database.connection
        .prepare(
          `SELECT
            runtime_id, object_kind, task_surface_ref, expires_at, derived_from,
            retention_policy, gap_kind, detected_in_run_id, surface_id, description,
            ttl_ms, recurrence_runs, recurrence_surfaces, governance_impact,
            unresolved_age_ms, upgrade_candidate
          FROM gap_records
          ORDER BY runtime_id ASC`
        )
        .all() as GapRecordRow[];

      const results: Array<Readonly<HandoffRecord | GapRecord>> = [
        ...handoffRows.map((row) => parseHandoffRow(row)),
        ...gapRows.map((row) => parseGapRow(row))
      ];

      return Object.freeze(results);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to list all handoff and gap records.", error);
    }
  }

  public findByRunId(runId: string): ReadonlyArray<Readonly<HandoffRecord | GapRecord>> {
    try {
      const handoffRows = this.database.connection
        .prepare(
          `SELECT
            runtime_id, object_kind, task_surface_ref, expires_at, derived_from,
            retention_policy, handoff_kind, source_run_id, target_run_id, surface_id,
            ttl_ms, recurrence_runs, recurrence_surfaces, governance_impact,
            unresolved_age_ms, upgrade_candidate
          FROM handoff_records
          WHERE source_run_id = ?
          ORDER BY runtime_id ASC`
        )
        .all(runId) as HandoffRecordRow[];

      const gapRows = this.database.connection
        .prepare(
          `SELECT
            runtime_id, object_kind, task_surface_ref, expires_at, derived_from,
            retention_policy, gap_kind, detected_in_run_id, surface_id, description,
            ttl_ms, recurrence_runs, recurrence_surfaces, governance_impact,
            unresolved_age_ms, upgrade_candidate
          FROM gap_records
          WHERE detected_in_run_id = ?
          ORDER BY runtime_id ASC`
        )
        .all(runId) as GapRecordRow[];

      const results: Array<Readonly<HandoffRecord | GapRecord>> = [
        ...handoffRows.map((row) => parseHandoffRow(row)),
        ...gapRows.map((row) => parseGapRow(row))
      ];

      return Object.freeze(results);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find records for run ${runId}.`,
        error
      );
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  public deleteById(id: string): void {
    try {
      this.database.connection
        .prepare("DELETE FROM handoff_records WHERE runtime_id = ?")
        .run(id);

      this.database.connection
        .prepare("DELETE FROM gap_records WHERE runtime_id = ?")
        .run(id);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to delete record ${id}.`,
        error
      );
    }
  }

  public deleteExpired(nowIso: string): number {
    try {
      const handoffResult = this.database.connection
        .prepare(
          "DELETE FROM handoff_records WHERE expires_at IS NOT NULL AND expires_at <= ?"
        )
        .run(nowIso);

      const gapResult = this.database.connection
        .prepare(
          "DELETE FROM gap_records WHERE expires_at IS NOT NULL AND expires_at <= ?"
        )
        .run(nowIso);

      return handoffResult.changes + gapResult.changes;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to delete expired records.", error);
    }
  }

  // -------------------------------------------------------------------------
  // Find expired
  // -------------------------------------------------------------------------

  public findExpiredObjects(
    nowIso: string
  ): ReadonlyArray<{ object_kind: string; object_id: string; expires_at: string }> {
    try {
      const rows = this.database.connection
        .prepare(
          `SELECT runtime_id AS object_id, object_kind, expires_at
          FROM handoff_records
          WHERE expires_at IS NOT NULL AND expires_at <= ?
          UNION
          SELECT runtime_id AS object_id, object_kind, expires_at
          FROM gap_records
          WHERE expires_at IS NOT NULL AND expires_at <= ?
          ORDER BY expires_at ASC`
        )
        .all(nowIso, nowIso) as ExpiredObjectRow[];

      return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to find expired objects.", error);
    }
  }

  /**
   * Workspace-scoped variant: only returns expired objects whose associated run
   * belongs to the given workspace (joins against runs table).
   */
  public findExpiredObjectsByWorkspace(
    workspaceId: string,
    nowIso: string
  ): ReadonlyArray<{ object_kind: string; object_id: string; expires_at: string }> {
    try {
      const rows = this.database.connection
        .prepare(
          `SELECT h.runtime_id AS object_id, h.object_kind, h.expires_at
          FROM handoff_records h
          INNER JOIN runs r ON h.source_run_id = r.run_id
          WHERE h.expires_at IS NOT NULL AND h.expires_at <= ? AND r.workspace_id = ?
          UNION
          SELECT g.runtime_id AS object_id, g.object_kind, g.expires_at
          FROM gap_records g
          INNER JOIN runs r ON g.detected_in_run_id = r.run_id
          WHERE g.expires_at IS NOT NULL AND g.expires_at <= ? AND r.workspace_id = ?
          ORDER BY expires_at ASC`
        )
        .all(nowIso, workspaceId, nowIso, workspaceId) as ExpiredObjectRow[];

      return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to find expired objects by workspace.", error);
    }
  }
}

function parseHandoffRecordForCreate(record: HandoffRecord): Readonly<HandoffRecord> {
  try {
    return deepFreeze(HandoffRecordSchema.parse(record));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate handoff record.", error);
  }
}

function parseGapRecordForCreate(record: GapRecord): Readonly<GapRecord> {
  try {
    return deepFreeze(GapRecordSchema.parse(record));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate gap record.", error);
  }
}

function insertHandoffRecord(database: StorageDatabase, parsed: Readonly<HandoffRecord>): void {
  database.connection.prepare(INSERT_HANDOFF_RECORD_SQL).run(
    parsed.runtime_id,
    parsed.object_kind,
    parsed.task_surface_ref,
    parsed.expires_at,
    parsed.derived_from,
    parsed.retention_policy,
    parsed.handoff_kind,
    parsed.source_run_id,
    parsed.target_run_id,
    parsed.surface_id,
    parsed.ttl_ms,
    parsed.recurrence_runs,
    parsed.recurrence_surfaces,
    parsed.governance_impact,
    parsed.unresolved_age_ms,
    toNullableBooleanInt(parsed.upgrade_candidate)
  );
}

function insertGapRecord(database: StorageDatabase, parsed: Readonly<GapRecord>): void {
  database.connection.prepare(INSERT_GAP_RECORD_SQL).run(
    parsed.runtime_id,
    parsed.object_kind,
    parsed.task_surface_ref,
    parsed.expires_at,
    parsed.derived_from,
    parsed.retention_policy,
    parsed.gap_kind,
    parsed.detected_in_run_id,
    parsed.surface_id,
    parsed.description,
    parsed.ttl_ms,
    parsed.recurrence_runs,
    parsed.recurrence_surfaces,
    parsed.governance_impact,
    parsed.unresolved_age_ms,
    toNullableBooleanInt(parsed.upgrade_candidate)
  );
}

function requirePersistedHandoff(
  runtimeId: string,
  persisted: Readonly<HandoffRecord> | null
): Readonly<HandoffRecord> {
  if (persisted === null) {
    throw new StorageError("NOT_FOUND", `Handoff record ${runtimeId} was not found after insert.`);
  }
  return persisted;
}

function requirePersistedGap(
  runtimeId: string,
  persisted: Readonly<GapRecord> | null
): Readonly<GapRecord> {
  if (persisted === null) {
    throw new StorageError("NOT_FOUND", `Gap record ${runtimeId} was not found after insert.`);
  }
  return persisted;
}

function toNullableBooleanInt(value: boolean | null): 0 | 1 | null {
  return value === null ? null : value ? 1 : 0;
}
