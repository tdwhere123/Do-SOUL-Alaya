import {
  EventLogOrphanRadarRecordSchema,
  OrphanRadarSchema,
  type EventLogOrphanRadarRecord,
  type OrphanRadar
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

const ORPHAN_RADAR_LIST_LIMIT = 200;

export interface OrphanRadarRepo {
  create(record: Readonly<OrphanRadar>): Promise<Readonly<OrphanRadar>>;
  createEventLogOrphan(
    record: Readonly<EventLogOrphanRadarRecord>
  ): Promise<Readonly<EventLogOrphanRadarRecord>>;
  findById(radarId: string): Promise<Readonly<OrphanRadar> | null>;
  findActiveByWorkspaceId(
    workspaceId: string,
    now: string
  ): Promise<readonly Readonly<OrphanRadar>[]>;
  findByTargetMemory(memoryId: string, workspaceId: string): Promise<readonly Readonly<OrphanRadar>[]>;
  deleteExpired(now: string): Promise<number>;
}

interface OrphanRadarRow {
  readonly radar_id: string;
  readonly target_memory_id: string | null;
  readonly workspace_id: string;
  readonly suspected_surface_gaps_json: string;
  readonly suggested_action: OrphanRadar["suggested_action"];
  readonly confidence: number;
  readonly detected_at: string;
  readonly expires_at: string;
  readonly requires_review: number;
}

export class SqliteOrphanRadarRepo implements OrphanRadarRepo {
  public constructor(private readonly db: StorageDatabase) {}

  public async create(record: Readonly<OrphanRadar>): Promise<Readonly<OrphanRadar>> {
    const parsed = parseRecord(record);

    try {
      this.db.connection
        .prepare(
          `INSERT INTO orphan_radar (
            radar_id,
            target_memory_id,
            workspace_id,
            suspected_surface_gaps_json,
            suggested_action,
            confidence,
            detected_at,
            expires_at,
            requires_review
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          parsed.radar_id,
          parsed.target_memory_id,
          parsed.workspace_id,
          JSON.stringify(parsed.suspected_surface_gaps),
          parsed.suggested_action,
          parsed.confidence,
          parsed.detected_at,
          parsed.expires_at,
          parsed.requires_review ? 1 : 0
        );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create orphan radar ${parsed.radar_id}.`, error);
    }

    return parsed;
  }

  public async createEventLogOrphan(
    record: Readonly<EventLogOrphanRadarRecord>
  ): Promise<Readonly<EventLogOrphanRadarRecord>> {
    const parsed = parseEventLogOrphanRecord(record);

    try {
      const result = this.db.connection
        .prepare(
          `INSERT OR IGNORE INTO orphan_radar (
            radar_id,
            target_memory_id,
            target_event_id,
            target_event_type,
            expected_table,
            workspace_id,
            suspected_surface_gaps_json,
            suggested_action,
            confidence,
            detected_at,
            expires_at,
            requires_review
          ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          parsed.radar_id,
          parsed.audit_event_id,
          parsed.event_type,
          parsed.expected_table,
          parsed.workspace_id,
          JSON.stringify([`event_log:${parsed.expected_table}:missing_audit_event_id`]),
          "re_anchor_candidate",
          1,
          parsed.detected_at,
          parsed.expires_at,
          parsed.requires_review ? 1 : 0
        );
      if (result.changes !== 1) {
        throw new StorageError(
          "CONFLICT",
          `EventLog orphan radar already exists for audit event ${parsed.audit_event_id}.`
        );
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create EventLog orphan radar ${parsed.radar_id}.`,
        error
      );
    }

    return parsed;
  }

  public async findById(radarId: string): Promise<Readonly<OrphanRadar> | null> {
    const parsedRadarId = parseNonEmptyString(radarId, "radar id");

    try {
      const row = this.db.connection
        .prepare(
          `SELECT
             radar_id,
             target_memory_id,
             workspace_id,
             suspected_surface_gaps_json,
             suggested_action,
             confidence,
             detected_at,
             expires_at,
             requires_review
           FROM orphan_radar
           WHERE radar_id = ? AND target_event_id IS NULL
           LIMIT 1`
        )
        .get(parsedRadarId) as OrphanRadarRow | undefined;

      return row === undefined ? null : parseRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load orphan radar ${parsedRadarId}.`, error);
    }
  }

  public async findActiveByWorkspaceId(
    workspaceId: string,
    now: string
  ): Promise<readonly Readonly<OrphanRadar>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedNow = parseTimestamp(now);

    try {
      const rows = this.db.connection
        .prepare(
          `SELECT
             radar_id,
             target_memory_id,
             workspace_id,
             suspected_surface_gaps_json,
             suggested_action,
             confidence,
             detected_at,
             expires_at,
             requires_review
           FROM orphan_radar
           WHERE workspace_id = ? AND expires_at > ? AND target_event_id IS NULL
           ORDER BY detected_at DESC, radar_id ASC
           LIMIT ${ORPHAN_RADAR_LIST_LIMIT}`
        )
        .all(parsedWorkspaceId, parsedNow) as OrphanRadarRow[];

      return Object.freeze(rows.map((row) => parseRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list active orphan radar rows for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findByTargetMemory(memoryId: string, workspaceId: string): Promise<readonly Readonly<OrphanRadar>[]> {
    const parsedMemoryId = parseNonEmptyString(memoryId, "memory id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.db.connection
        .prepare(
          `SELECT
             radar_id,
             target_memory_id,
             workspace_id,
             suspected_surface_gaps_json,
             suggested_action,
             confidence,
             detected_at,
             expires_at,
             requires_review
           FROM orphan_radar
           WHERE target_memory_id = ? AND workspace_id = ?
           ORDER BY detected_at DESC, radar_id ASC
           LIMIT ${ORPHAN_RADAR_LIST_LIMIT}`
        )
        .all(parsedMemoryId, parsedWorkspaceId) as OrphanRadarRow[];

      return Object.freeze(rows.map((row) => parseRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list orphan radar rows for memory ${parsedMemoryId}.`,
        error
      );
    }
  }

  public async deleteExpired(now: string): Promise<number> {
    const parsedNow = parseTimestamp(now);

    try {
      const result = this.db.connection
        .prepare("DELETE FROM orphan_radar WHERE expires_at <= ?")
        .run(parsedNow);

      return result.changes;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to delete expired orphan radar rows.", error);
    }
  }
}

function parseRecord(record: Readonly<OrphanRadar>): Readonly<OrphanRadar> {
  try {
    return deepFreeze(
      OrphanRadarSchema.parse({
        radar_id: parseNonEmptyString(record.radar_id, "radar id"),
        target_memory_id: parseNonEmptyString(record.target_memory_id, "target memory id"),
        workspace_id: parseNonEmptyString(record.workspace_id, "workspace id"),
        suspected_surface_gaps: record.suspected_surface_gaps,
        suggested_action: record.suggested_action,
        confidence: record.confidence,
        detected_at: parseTimestamp(record.detected_at),
        expires_at: parseTimestamp(record.expires_at),
        requires_review: record.requires_review
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate orphan radar.", error);
  }
}

function parseEventLogOrphanRecord(
  record: Readonly<EventLogOrphanRadarRecord>
): Readonly<EventLogOrphanRadarRecord> {
  try {
    return deepFreeze(
      EventLogOrphanRadarRecordSchema.parse({
        radar_id: parseNonEmptyString(record.radar_id, "radar id"),
        audit_event_id: parseNonEmptyString(record.audit_event_id, "audit event id"),
        event_type: parseNonEmptyString(record.event_type, "event type"),
        expected_table: record.expected_table,
        workspace_id: parseNonEmptyString(record.workspace_id, "workspace id"),
        detected_at: parseTimestamp(record.detected_at),
        expires_at: parseTimestamp(record.expires_at),
        requires_review: record.requires_review
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate EventLog orphan radar.", error);
  }
}

function parseRow(row: OrphanRadarRow): Readonly<OrphanRadar> {
  try {
    return deepFreeze(
      OrphanRadarSchema.parse({
        radar_id: row.radar_id,
        target_memory_id: row.target_memory_id,
        workspace_id: row.workspace_id,
        suspected_surface_gaps: JSON.parse(row.suspected_surface_gaps_json) as unknown[],
        suggested_action: row.suggested_action,
        confidence: row.confidence,
        detected_at: row.detected_at,
        expires_at: row.expires_at,
        requires_review: row.requires_review === 1
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse orphan radar row.", error);
  }
}
