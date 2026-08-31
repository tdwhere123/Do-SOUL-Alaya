import { createHash } from "node:crypto";
import {
  verifyEvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationCapture
} from "@do-soul/alaya-protocol";

export interface StoredFactFrameFormationColumns {
  readonly formation_workspace_id: string | null;
  readonly formation_schema_version: number | null;
  readonly formation_operator_id: string | null;
  readonly formation_status: string | null;
  readonly formation_producer_operator_id: string | null;
  readonly formation_source_hash: string | null;
  readonly formation_fact_frame_json: string | null;
  readonly formation_capture_digest: string | null;
}

export function readStoredFactFrameFormation(
  row: Readonly<StoredFactFrameFormationColumns>,
  expectedWorkspaceId: string,
  expectedProjectionSourceHash: string
): Readonly<EvidenceFactFrameFormationCapture> | undefined {
  if (row.formation_operator_id === null) return undefined;
  if (row.formation_workspace_id !== expectedWorkspaceId) {
    throw new Error("fact-frame formation workspace does not match its projection");
  }
  const capture = verifyEvidenceFactFrameFormationCapture({
    schema_version: row.formation_schema_version,
    operator_id: row.formation_operator_id,
    status: row.formation_status,
    producer_operator_id: row.formation_producer_operator_id,
    source_hash: row.formation_source_hash,
    fact_frame: parseFactFrame(row.formation_fact_frame_json),
    capture_digest: row.formation_capture_digest
  }, sha256);
  if (capture.source_hash !== null &&
      capture.source_hash !== expectedProjectionSourceHash) {
    throw new Error("fact-frame formation source does not match its projection");
  }
  return capture;
}

function parseFactFrame(value: string | null): unknown {
  if (value === null) return null;
  return JSON.parse(value) as unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
