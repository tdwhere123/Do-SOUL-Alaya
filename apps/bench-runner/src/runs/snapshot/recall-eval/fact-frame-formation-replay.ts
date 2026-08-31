import { replayEvidenceFactFrameFormationCapture } from "@do-soul/alaya-core";
import type { EvidenceSearchProjection } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";

interface StoredFormationRow {
  readonly workspace_id: string;
  readonly schema_version: number;
  readonly operator_id: string;
  readonly status: string;
  readonly producer_operator_id: string | null;
  readonly source_hash: string | null;
  readonly fact_frame_json: string | null;
  readonly capture_digest: string;
}

export function replayStoredEvidenceFactFrameFormation(
  db: StorageDatabase,
  owner: Readonly<{
    readonly objectId: string;
    readonly workspaceId: string;
    readonly sourceHash: string;
    readonly sourceAssertion: string | null;
  }>
): readonly Readonly<EvidenceSearchProjection>[] {
  const row = db.connection.prepare(READ_FORMATION_SQL).get(
    owner.objectId
  ) as StoredFormationRow | undefined;
  if (row === undefined) return Object.freeze([]);
  if (row.workspace_id !== owner.workspaceId) {
    throw new Error("fact-frame formation workspace mismatch");
  }
  return replayEvidenceFactFrameFormationCapture({
    sourceAssertion: owner.sourceAssertion,
    sourceHash: owner.sourceHash,
    capture: {
      schema_version: row.schema_version,
      operator_id: row.operator_id,
      status: row.status,
      producer_operator_id: row.producer_operator_id,
      source_hash: row.source_hash,
      fact_frame: row.fact_frame_json === null ? null : JSON.parse(row.fact_frame_json),
      capture_digest: row.capture_digest
    }
  }).searchProjections;
}

const READ_FORMATION_SQL = `
  SELECT workspace_id, schema_version, operator_id, status,
         producer_operator_id, source_hash, fact_frame_json, capture_digest
  FROM evidence_fact_frame_formations
  WHERE evidence_object_id = ?
`;
