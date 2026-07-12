import type { StrongRef } from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import {
  readBufferField,
  readNonEmptyStringField,
  readPositiveIntField,
  readRecord,
  readSqliteBooleanIntField,
  type RowParser
} from "./parse-row.js";

const STRONG_REF_REASONS = new Set<StrongRef["reason"]>([
  "governance_lease",
  "security_snapshot",
  "active_projection"
]);

export interface SurfaceBindingRow {
  readonly binding_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly object_id: string;
  readonly surface_id: string;
  readonly is_primary: number;
  readonly binding_state: string;
  readonly workspace_id: string;
}

export interface StrongRefRow {
  readonly ref_id: string;
  readonly source_entity_type: string;
  readonly source_entity_id: string;
  readonly target_entity_type: string;
  readonly target_entity_id: string;
  readonly workspace_id: string;
  readonly reason: StrongRef["reason"];
  readonly created_at: string;
}

export interface MemoryEmbeddingRow {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content_hash: string;
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly embedding_blob: Buffer;
  readonly created_at: string;
  readonly updated_at: string;
}

export type MemoryEmbeddingMetadataRow = Omit<MemoryEmbeddingRow, "embedding_blob">;

export const SurfaceBindingRowParser: RowParser<SurfaceBindingRow> = {
  parse(value: unknown): SurfaceBindingRow {
    const record = readRecord(value, "surface binding row");
    return {
      binding_id: readNonEmptyStringField(record, "binding_id"),
      object_kind: readNonEmptyStringField(record, "object_kind"),
      schema_version: readPositiveIntField(record, "schema_version"),
      lifecycle_state: readNonEmptyStringField(record, "lifecycle_state"),
      created_at: readNonEmptyStringField(record, "created_at"),
      updated_at: readNonEmptyStringField(record, "updated_at"),
      created_by: readNonEmptyStringField(record, "created_by"),
      object_id: readNonEmptyStringField(record, "object_id"),
      surface_id: readNonEmptyStringField(record, "surface_id"),
      is_primary: readSqliteBooleanIntField(record, "is_primary"),
      binding_state: readNonEmptyStringField(record, "binding_state"),
      workspace_id: readNonEmptyStringField(record, "workspace_id")
    };
  }
};

export const StrongRefRowParser: RowParser<StrongRefRow> = {
  parse(value: unknown): StrongRefRow {
    const record = readRecord(value, "strong ref row");
    const reason = record.reason;
    if (typeof reason !== "string" || !STRONG_REF_REASONS.has(reason as StrongRef["reason"])) {
      throw new StorageError("VALIDATION_FAILED", "Failed to validate reason.");
    }

    return {
      ref_id: readNonEmptyStringField(record, "ref_id"),
      source_entity_type: readNonEmptyStringField(record, "source_entity_type"),
      source_entity_id: readNonEmptyStringField(record, "source_entity_id"),
      target_entity_type: readNonEmptyStringField(record, "target_entity_type"),
      target_entity_id: readNonEmptyStringField(record, "target_entity_id"),
      workspace_id: readNonEmptyStringField(record, "workspace_id"),
      reason: reason as StrongRef["reason"],
      created_at: readNonEmptyStringField(record, "created_at")
    };
  }
};

export const MemoryEmbeddingRowParser: RowParser<MemoryEmbeddingRow> = {
  parse(value: unknown): MemoryEmbeddingRow {
    const record = readRecord(value, "memory embedding row");
    return {
      object_id: readNonEmptyStringField(record, "object_id"),
      workspace_id: readNonEmptyStringField(record, "workspace_id"),
      content_hash: readNonEmptyStringField(record, "content_hash"),
      provider_kind: readNonEmptyStringField(record, "provider_kind"),
      model_id: readNonEmptyStringField(record, "model_id"),
      schema_version: readPositiveIntField(record, "schema_version"),
      dimensions: readPositiveIntField(record, "dimensions"),
      embedding_blob: readBufferField(record, "embedding_blob"),
      created_at: readNonEmptyStringField(record, "created_at"),
      updated_at: readNonEmptyStringField(record, "updated_at")
    };
  }
};

export const MemoryEmbeddingMetadataRowParser: RowParser<MemoryEmbeddingMetadataRow> = {
  parse(value: unknown): MemoryEmbeddingMetadataRow {
    const record = readRecord(value, "memory embedding metadata row");
    return {
      object_id: readNonEmptyStringField(record, "object_id"),
      workspace_id: readNonEmptyStringField(record, "workspace_id"),
      content_hash: readNonEmptyStringField(record, "content_hash"),
      provider_kind: readNonEmptyStringField(record, "provider_kind"),
      model_id: readNonEmptyStringField(record, "model_id"),
      schema_version: readPositiveIntField(record, "schema_version"),
      dimensions: readPositiveIntField(record, "dimensions"),
      created_at: readNonEmptyStringField(record, "created_at"),
      updated_at: readNonEmptyStringField(record, "updated_at")
    };
  }
};
