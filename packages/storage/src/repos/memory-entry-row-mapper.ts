import {
  MemoryDimensionSchema,
  MemoryEntrySchema,
  ObjectLifecycleStateSchema,
  ScopeClassSchema,
  StorageTierSchema,
  type MemoryDimension,
  type MemoryEntry,
  type ScopeClass,
  type StorageTier
} from "@do-soul/alaya-protocol";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";
import type { MemoryEntryRepoDynamicsUpdateFields, MemoryEntryRepoUpdateFields } from "./memory-entry-repo.js";

export const MEMORY_ENTRY_SELECT_COLUMNS = `
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        dimension,
        source_kind,
        formation_kind,
        scope_class,
        content,
        domain_tags,
        evidence_refs,
        workspace_id,
        run_id,
        surface_id,
        storage_tier,
        activation_score,
        retention_score,
        manifestation_state,
        retention_state,
        decay_profile,
        confidence,
        last_used_at,
        last_hit_at,
        reinforcement_count,
        contradiction_count,
        superseded_by
`;
export interface MemoryEntryRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly dimension: string;
  readonly source_kind: string;
  readonly formation_kind: string;
  readonly scope_class: string;
  readonly content: string;
  readonly domain_tags: string;
  readonly evidence_refs: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly storage_tier: string;
  readonly activation_score: number | null;
  readonly retention_score: number | null;
  readonly manifestation_state: string | null;
  readonly retention_state: string | null;
  readonly decay_profile: string | null;
  readonly confidence: number | null;
  readonly last_used_at: string | null;
  readonly last_hit_at: string | null;
  readonly reinforcement_count: number | null;
  readonly contradiction_count: number | null;
  readonly superseded_by: string | null;
}

export function parseMemoryEntry(value: MemoryEntry): Readonly<MemoryEntry> {
  try {
    return deepFreeze(MemoryEntrySchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate memory entry.", error);
  }
}

export function parseMemoryEntryRow(row: MemoryEntryRow): Readonly<MemoryEntry> {
  try {
    return deepFreeze(
      MemoryEntrySchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        dimension: row.dimension,
        source_kind: row.source_kind,
        formation_kind: row.formation_kind,
        scope_class: row.scope_class,
        content: row.content,
        domain_tags: JSON.parse(row.domain_tags),
        evidence_refs: JSON.parse(row.evidence_refs),
        workspace_id: row.workspace_id,
        run_id: row.run_id,
        surface_id: row.surface_id,
        storage_tier: row.storage_tier,
        activation_score: row.activation_score,
        retention_score: row.retention_score,
        manifestation_state: row.manifestation_state,
        retention_state: row.retention_state,
        decay_profile: row.decay_profile,
        confidence: row.confidence,
        last_used_at: row.last_used_at,
        last_hit_at: row.last_hit_at,
        reinforcement_count: row.reinforcement_count,
        contradiction_count: row.contradiction_count,
        superseded_by: row.superseded_by
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate memory entry row.", error);
  }
}

export function parseMemoryDimension(value: MemoryDimension): MemoryDimension {
  try {
    return MemoryDimensionSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate memory dimension.", error);
  }
}

export function parseScopeClass(value: ScopeClass): ScopeClass {
  try {
    return ScopeClassSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate scope class.", error);
  }
}

export function parseStorageTier(value: StorageTier): StorageTier {
  try {
    return StorageTierSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate storage tier.", error);
  }
}

export function parseUpdateFields(fields: MemoryEntryRepoUpdateFields): MemoryEntryRepoUpdateFields {
  const updatedAt = parseUpdatedAt(fields.updated_at);

  if (fields.content !== undefined && fields.content.trim().length === 0) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate memory content.");
  }

  if (fields.domain_tags !== undefined) {
    parseStringArray(fields.domain_tags, "domain_tags");
  }

  if (fields.evidence_refs !== undefined) {
    parseStringArray(fields.evidence_refs, "evidence_refs");
  }

  const parsedStorageTier =
    fields.storage_tier === undefined ? undefined : parseStorageTier(fields.storage_tier);
  const parsedLastUsedAt =
    fields.last_used_at === undefined ? undefined : parseTimestamp(fields.last_used_at);
  const parsedLastHitAt =
    fields.last_hit_at === undefined ? undefined : parseTimestamp(fields.last_hit_at);

  return {
    ...fields,
    updated_at: updatedAt,
    storage_tier: parsedStorageTier,
    last_used_at: parsedLastUsedAt,
    last_hit_at: parsedLastHitAt
  };
}

export function parseDynamicsUpdateFields(
  fields: MemoryEntryRepoDynamicsUpdateFields
): MemoryEntryRepoDynamicsUpdateFields {
  if (!Number.isFinite(fields.activation_score) || fields.activation_score < 0 || fields.activation_score > 1) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate activation_score.");
  }

  if (!Number.isFinite(fields.retention_score) || fields.retention_score < 0 || fields.retention_score > 1) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate retention_score.");
  }

  if (
    fields.manifestation_state !== "hidden" &&
    fields.manifestation_state !== "hint" &&
    fields.manifestation_state !== "excerpt" &&
    fields.manifestation_state !== "full_eligible"
  ) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate manifestation_state.");
  }

  if (fields.retention_state !== undefined && fields.retention_state !== null) {
    parseRetentionState(fields.retention_state);
  }

  if (fields.last_used_at !== undefined) {
    parseTimestamp(fields.last_used_at);
  }

  if (fields.last_hit_at !== undefined) {
    parseTimestamp(fields.last_hit_at);
  }

  if (fields.reinforcement_count !== undefined) {
    if (!Number.isInteger(fields.reinforcement_count) || fields.reinforcement_count < 0) {
      throw new StorageError("VALIDATION_FAILED", "Failed to validate reinforcement_count.");
    }
  }

  if (fields.contradiction_count !== undefined) {
    if (!Number.isInteger(fields.contradiction_count) || fields.contradiction_count < 0) {
      throw new StorageError("VALIDATION_FAILED", "Failed to validate contradiction_count.");
    }
  }

  if (fields.superseded_by !== undefined) {
    parseNonEmptyString(fields.superseded_by, "superseded_by");
  }

  return fields;
}

export const parseUpdatedAt = parseTimestamp;

export function parseLifecycleState(value: MemoryEntry["lifecycle_state"]): MemoryEntry["lifecycle_state"] {
  try {
    return ObjectLifecycleStateSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate lifecycle_state.", error);
  }
}

function parseRetentionState(value: NonNullable<MemoryEntry["retention_state"]>): NonNullable<MemoryEntry["retention_state"]> {
  if (
    value === "working" ||
    value === "consolidated" ||
    value === "canon" ||
    value === "archived" ||
    value === "tombstoned"
  ) {
    return value;
  }

  throw new StorageError("VALIDATION_FAILED", "Failed to validate retention_state.");
}

function parseStringArray(value: readonly string[], field: "domain_tags" | "evidence_refs"): void {
  for (const item of value) {
    if (item.trim().length === 0) {
      throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
    }
  }
}
