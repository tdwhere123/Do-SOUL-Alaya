import { GapRecordSchema, HandoffRecordSchema, type GapRecord, type HandoffRecord } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";

interface HandoffRecordRow {
  readonly runtime_id: string;
  readonly object_kind: string;
  readonly task_surface_ref: string | null;
  readonly expires_at: string | null;
  readonly derived_from: string | null;
  readonly retention_policy: string;
  readonly handoff_kind: string;
  readonly source_run_id: string;
  readonly target_run_id: string | null;
  readonly surface_id: string | null;
  readonly ttl_ms: number | null;
}

interface GapRecordRow {
  readonly runtime_id: string;
  readonly object_kind: string;
  readonly task_surface_ref: string | null;
  readonly expires_at: string | null;
  readonly derived_from: string | null;
  readonly retention_policy: string;
  readonly gap_kind: string;
  readonly detected_in_run_id: string;
  readonly surface_id: string | null;
  readonly description: string;
  readonly ttl_ms: number | null;
}

interface ExpiredObjectRow {
  readonly object_kind: string;
  readonly object_id: string;
  readonly expires_at: string;
}

function parseHandoffRow(row: HandoffRecordRow): Readonly<HandoffRecord> {
  try {
    return deepFreeze(
      HandoffRecordSchema.parse({
        runtime_id: row.runtime_id,
        object_kind: row.object_kind,
        task_surface_ref: row.task_surface_ref,
        expires_at: row.expires_at,
        derived_from: row.derived_from,
        retention_policy: row.retention_policy,
        handoff_kind: row.handoff_kind,
        source_run_id: row.source_run_id,
        target_run_id: row.target_run_id,
        surface_id: row.surface_id,
        ttl_ms: row.ttl_ms
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse handoff record row.", error);
  }
}

function parseGapRow(row: GapRecordRow): Readonly<GapRecord> {
  try {
    return deepFreeze(
      GapRecordSchema.parse({
        runtime_id: row.runtime_id,
        object_kind: row.object_kind,
        task_surface_ref: row.task_surface_ref,
        expires_at: row.expires_at,
        derived_from: row.derived_from,
        retention_policy: row.retention_policy,
        gap_kind: row.gap_kind,
        detected_in_run_id: row.detected_in_run_id,
        surface_id: row.surface_id,
        description: row.description,
        ttl_ms: row.ttl_ms
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse gap record row.", error);
  }
}

const HANDOFF_COLUMNS = `
  runtime_id, object_kind, task_surface_ref, expires_at, derived_from,
  retention_policy, handoff_kind, source_run_id, target_run_id, surface_id,
  ttl_ms
`;

const GAP_COLUMNS = `
  runtime_id, object_kind, task_surface_ref, expires_at, derived_from,
  retention_policy, gap_kind, detected_in_run_id, surface_id, description,
  ttl_ms
`;

export class SqliteHandoffGapRepo {
  private readonly database: StorageDatabase;

  public constructor(database: StorageDatabase) {
    this.database = database;
  }

  public createHandoff(record: HandoffRecord): Readonly<HandoffRecord> {
    let parsed: Readonly<HandoffRecord>;

    try {
      parsed = deepFreeze(HandoffRecordSchema.parse(record));
    } catch (error) {
      throw new StorageError("VALIDATION_FAILED", "Failed to validate handoff record.", error);
    }

    try {
      this.database.connection
        .prepare(
          `INSERT INTO handoff_records (${HANDOFF_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
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
          parsed.ttl_ms
        );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create handoff record ${parsed.runtime_id}.`,
        error
      );
    }

    return parsed;
  }

  public createGap(record: GapRecord): Readonly<GapRecord> {
    let parsed: Readonly<GapRecord>;

    try {
      parsed = deepFreeze(GapRecordSchema.parse(record));
    } catch (error) {
      throw new StorageError("VALIDATION_FAILED", "Failed to validate gap record.", error);
    }

    try {
      this.database.connection
        .prepare(
          `INSERT INTO gap_records (${GAP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
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
          parsed.ttl_ms
        );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create gap record ${parsed.runtime_id}.`,
        error
      );
    }

    return parsed;
  }

  public findHandoffById(id: string): Readonly<HandoffRecord> | null {
    try {
      const row = this.database.connection
        .prepare(`SELECT ${HANDOFF_COLUMNS} FROM handoff_records WHERE runtime_id = ? LIMIT 1`)
        .get(id) as HandoffRecordRow | undefined;

      return row === undefined ? null : parseHandoffRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load handoff record ${id}.`, error);
    }
  }

  public findGapById(id: string): Readonly<GapRecord> | null {
    try {
      const row = this.database.connection
        .prepare(`SELECT ${GAP_COLUMNS} FROM gap_records WHERE runtime_id = ? LIMIT 1`)
        .get(id) as GapRecordRow | undefined;

      return row === undefined ? null : parseGapRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load gap record ${id}.`, error);
    }
  }

  public listAll(): ReadonlyArray<Readonly<HandoffRecord | GapRecord>> {
    try {
      const handoffRows = this.database.connection
        .prepare(`SELECT ${HANDOFF_COLUMNS} FROM handoff_records ORDER BY runtime_id ASC`)
        .all() as HandoffRecordRow[];

      const gapRows = this.database.connection
        .prepare(`SELECT ${GAP_COLUMNS} FROM gap_records ORDER BY runtime_id ASC`)
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
          `SELECT ${HANDOFF_COLUMNS} FROM handoff_records WHERE source_run_id = ? ORDER BY runtime_id ASC`
        )
        .all(runId) as HandoffRecordRow[];

      const gapRows = this.database.connection
        .prepare(
          `SELECT ${GAP_COLUMNS} FROM gap_records WHERE detected_in_run_id = ? ORDER BY runtime_id ASC`
        )
        .all(runId) as GapRecordRow[];

      const results: Array<Readonly<HandoffRecord | GapRecord>> = [
        ...handoffRows.map((row) => parseHandoffRow(row)),
        ...gapRows.map((row) => parseGapRow(row))
      ];

      return Object.freeze(results);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to find records for run ${runId}.`, error);
    }
  }

  public deleteById(id: string): void {
    try {
      this.database.connection
        .prepare("DELETE FROM handoff_records WHERE runtime_id = ?")
        .run(id);

      this.database.connection
        .prepare("DELETE FROM gap_records WHERE runtime_id = ?")
        .run(id);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to delete record ${id}.`, error);
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
   * Workspace-scoped variant: returns expired objects whose associated run
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
