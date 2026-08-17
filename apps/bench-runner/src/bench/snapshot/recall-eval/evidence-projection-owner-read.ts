import {
  GARDEN_SOURCE_TURN_FALLBACK_ARTIFACT_PREFIX,
  GARDEN_SOURCE_TURN_FALLBACK_V2_SOURCE_HASH_PREFIX
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";

export interface EvidenceProjectionOwnerRow {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly source_hash: string | null;
  readonly excerpt: string | null;
  readonly artifact_ref: string | null;
}

export function readEvidenceProjectionOwners(
  db: StorageDatabase
): readonly EvidenceProjectionOwnerRow[] {
  return db.connection.prepare(READ_OWNERS_SQL).all(
    GARDEN_SOURCE_TURN_FALLBACK_ARTIFACT_PREFIX,
    GARDEN_SOURCE_TURN_FALLBACK_ARTIFACT_PREFIX,
    GARDEN_SOURCE_TURN_FALLBACK_V2_SOURCE_HASH_PREFIX,
    GARDEN_SOURCE_TURN_FALLBACK_V2_SOURCE_HASH_PREFIX
  ) as EvidenceProjectionOwnerRow[];
}

const READ_OWNERS_SQL = `
  SELECT object_id, workspace_id, source_hash, excerpt,
         CASE
           WHEN json_valid(physical_anchor)
             AND json_type(physical_anchor, '$.artifact_ref') = 'text'
           THEN json_extract(physical_anchor, '$.artifact_ref')
           ELSE NULL
         END AS artifact_ref
  FROM evidence_capsules
  WHERE (
    CASE
      WHEN json_valid(physical_anchor)
        AND json_type(physical_anchor, '$.artifact_ref') = 'text'
      THEN substr(json_extract(physical_anchor, '$.artifact_ref'), 1, length(?)) = ?
      ELSE 0
    END
  ) OR substr(COALESCE(source_hash, ''), 1, length(?)) = ?
  ORDER BY object_id ASC
`;
