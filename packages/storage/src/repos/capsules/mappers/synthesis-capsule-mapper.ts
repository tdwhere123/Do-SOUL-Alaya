import { SynthesisCapsuleSchema, deepFreeze, type SynthesisCapsule } from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";

export interface SynthesisCapsuleRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly topic_key: string;
  readonly synthesis_type: string;
  readonly summary: string;
  readonly evidence_refs: string;
  readonly source_memory_refs: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly synthesis_status: string;
}

export function parseSynthesisCapsuleRow(row: SynthesisCapsuleRow): Readonly<SynthesisCapsule> {
  try {
    return deepFreeze(
      SynthesisCapsuleSchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        topic_key: row.topic_key,
        synthesis_type: row.synthesis_type,
        summary: row.summary,
        evidence_refs: JSON.parse(row.evidence_refs),
        source_memory_refs: JSON.parse(row.source_memory_refs),
        workspace_id: row.workspace_id,
        run_id: row.run_id,
        synthesis_status: row.synthesis_status
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate synthesis capsule row.", error);
  }
}
