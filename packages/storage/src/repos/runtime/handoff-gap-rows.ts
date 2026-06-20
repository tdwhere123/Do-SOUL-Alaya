import { GapRecordSchema, HandoffRecordSchema, type GapRecord, type HandoffRecord } from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";

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
