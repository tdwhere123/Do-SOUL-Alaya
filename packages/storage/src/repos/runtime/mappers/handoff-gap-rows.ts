import { GapRecordSchema, HandoffRecordSchema, type GapRecord, type HandoffRecord } from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import { deepFreeze } from "@do-soul/alaya-protocol";
import {
  readIntegerField,
  readNonEmptyStringField,
  readNullableStringField,
  readRecord,
  type RowParser
} from "../../shared/parse-row.js";

export interface HandoffRecordRow {
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
  readonly recurrence_runs: number | null;
  readonly recurrence_surfaces: number | null;
  readonly governance_impact: number | null;
  readonly unresolved_age_ms: number | null;
  readonly upgrade_candidate: number | null;
}

export interface GapRecordRow {
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
  readonly recurrence_runs: number | null;
  readonly recurrence_surfaces: number | null;
  readonly governance_impact: number | null;
  readonly unresolved_age_ms: number | null;
  readonly upgrade_candidate: number | null;
}

export interface ExpiredObjectRow {
  readonly object_kind: string;
  readonly object_id: string;
  readonly expires_at: string;
}

function readRuntimeObjectRow(record: Record<string, unknown>): {
  readonly runtime_id: string;
  readonly object_kind: string;
  readonly task_surface_ref: string | null;
  readonly expires_at: string | null;
  readonly derived_from: string | null;
  readonly retention_policy: string;
  readonly ttl_ms: number | null;
  readonly recurrence_runs: number | null;
  readonly recurrence_surfaces: number | null;
  readonly governance_impact: number | null;
  readonly unresolved_age_ms: number | null;
  readonly upgrade_candidate: number | null;
} {
  return {
    runtime_id: readNonEmptyStringField(record, "runtime_id"),
    object_kind: readNonEmptyStringField(record, "object_kind"),
    task_surface_ref: readNullableStringField(record, "task_surface_ref"),
    expires_at: readNullableStringField(record, "expires_at"),
    derived_from: readNullableStringField(record, "derived_from"),
    retention_policy: readNonEmptyStringField(record, "retention_policy"),
    ttl_ms: record.ttl_ms === null ? null : readIntegerField(record, "ttl_ms"),
    recurrence_runs: record.recurrence_runs === null ? null : readIntegerField(record, "recurrence_runs"),
    recurrence_surfaces:
      record.recurrence_surfaces === null ? null : readIntegerField(record, "recurrence_surfaces"),
    governance_impact:
      record.governance_impact === null ? null : readIntegerField(record, "governance_impact"),
    unresolved_age_ms:
      record.unresolved_age_ms === null ? null : readIntegerField(record, "unresolved_age_ms"),
    upgrade_candidate:
      record.upgrade_candidate === null ? null : readIntegerField(record, "upgrade_candidate")
  };
}

export const HandoffRecordRowParser: RowParser<HandoffRecordRow> = {
  parse(value: unknown): HandoffRecordRow {
    const record = readRecord(value, "handoff record row");
    return {
      ...readRuntimeObjectRow(record),
      handoff_kind: readNonEmptyStringField(record, "handoff_kind"),
      source_run_id: readNonEmptyStringField(record, "source_run_id"),
      target_run_id: readNullableStringField(record, "target_run_id"),
      surface_id: readNullableStringField(record, "surface_id")
    };
  }
};

export const GapRecordRowParser: RowParser<GapRecordRow> = {
  parse(value: unknown): GapRecordRow {
    const record = readRecord(value, "gap record row");
    return {
      ...readRuntimeObjectRow(record),
      gap_kind: readNonEmptyStringField(record, "gap_kind"),
      detected_in_run_id: readNonEmptyStringField(record, "detected_in_run_id"),
      surface_id: readNullableStringField(record, "surface_id"),
      description: readNonEmptyStringField(record, "description")
    };
  }
};

export const ExpiredObjectRowParser: RowParser<ExpiredObjectRow> = {
  parse(value: unknown): ExpiredObjectRow {
    const record = readRecord(value, "expired object row");
    return {
      object_kind: readNonEmptyStringField(record, "object_kind"),
      object_id: readNonEmptyStringField(record, "object_id"),
      expires_at: readNonEmptyStringField(record, "expires_at")
    };
  }
};

export function parseHandoffRow(row: HandoffRecordRow): Readonly<HandoffRecord> {
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
        ttl_ms: row.ttl_ms,
        recurrence_runs: row.recurrence_runs,
        recurrence_surfaces: row.recurrence_surfaces,
        governance_impact: row.governance_impact,
        unresolved_age_ms: row.unresolved_age_ms,
        upgrade_candidate:
          row.upgrade_candidate === null ? null : row.upgrade_candidate === 1
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse handoff record row.", error);
  }
}

export function parseGapRow(row: GapRecordRow): Readonly<GapRecord> {
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
        ttl_ms: row.ttl_ms,
        recurrence_runs: row.recurrence_runs,
        recurrence_surfaces: row.recurrence_surfaces,
        governance_impact: row.governance_impact,
        unresolved_age_ms: row.unresolved_age_ms,
        upgrade_candidate:
          row.upgrade_candidate === null ? null : row.upgrade_candidate === 1
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse gap record row.", error);
  }
}
