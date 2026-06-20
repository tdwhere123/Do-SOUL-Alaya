import {
  EvidenceCapsuleSchema,
  EvidenceHealthStateSchema,
  type EvidenceCapsule,
  type EvidenceHealthState
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  DEFAULT_REPO_LIST_PAGE_LIMIT,
  parsePageLimit,
  parsePageOffset,
  parseTimestamp
} from "../shared/validators.js";
import type { EvidenceCapsuleListPageOptions } from "./evidence-capsule-repo.js";

export interface EvidenceCapsuleRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly evidence_kind: string;
  readonly semantic_anchor: string;
  readonly event_anchor: string | null;
  readonly physical_anchor: string | null;
  readonly evidence_health_state: string;
  readonly gist: string;
  readonly excerpt: string | null;
  readonly source_hash: string | null;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly surface_id: string | null;
}

export const EVIDENCE_CAPSULE_SELECT_COLUMNS = `
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        evidence_kind,
        semantic_anchor,
        event_anchor,
        physical_anchor,
        evidence_health_state,
        gist,
        excerpt,
        source_hash,
        run_id,
        workspace_id,
        surface_id
`;

export const DEFAULT_EVIDENCE_PAGE = Object.freeze({
  limit: DEFAULT_REPO_LIST_PAGE_LIMIT,
  offset: 0
});

export function parseEvidenceCapsule(value: EvidenceCapsule): Readonly<EvidenceCapsule> {
  try {
    return deepFreeze(EvidenceCapsuleSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate evidence capsule.", error);
  }
}

export function parseEvidenceCapsuleRow(row: EvidenceCapsuleRow): Readonly<EvidenceCapsule> {
  try {
    return deepFreeze(
      EvidenceCapsuleSchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        evidence_kind: row.evidence_kind,
        semantic_anchor: JSON.parse(row.semantic_anchor),
        event_anchor: row.event_anchor === null ? null : JSON.parse(row.event_anchor),
        physical_anchor: row.physical_anchor === null ? null : JSON.parse(row.physical_anchor),
        evidence_health_state: row.evidence_health_state,
        gist: row.gist,
        excerpt: row.excerpt,
        source_hash: row.source_hash,
        run_id: row.run_id,
        workspace_id: row.workspace_id,
        surface_id: row.surface_id
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate evidence capsule row.", error);
  }
}

export function parseEvidenceHealthState(health: EvidenceHealthState): EvidenceHealthState {
  try {
    return EvidenceHealthStateSchema.parse(health);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate evidence health state.", error);
  }
}

export function parseEvidenceCapsulePage(
  page: EvidenceCapsuleListPageOptions
): Readonly<EvidenceCapsuleListPageOptions> {
  return Object.freeze({
    limit: parsePageLimit(page.limit, "evidence capsule page limit"),
    offset: parsePageOffset(page.offset, "evidence capsule page offset")
  });
}

export const parseUpdatedAt = parseTimestamp;
