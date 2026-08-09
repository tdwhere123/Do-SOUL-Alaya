import { createHash } from "node:crypto";
import {
  verifyOpenSemanticFactorFormationCapture,
  type EvidenceCapsule,
  type OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";

export type EvidenceSemanticFactorFormationInsertArgs = readonly [
  evidenceObjectId: string,
  workspaceId: string,
  schemaVersion: number,
  operatorId: string,
  status: string,
  producerOperatorId: string | null,
  sourceSha256: string | null,
  graphJson: string | null,
  captureDigest: string
];

export function prepareSemanticFactorFormationInsert(
  capsule: Readonly<EvidenceCapsule>,
  capture?: Readonly<OpenSemanticFactorFormationCapture>
): EvidenceSemanticFactorFormationInsertArgs | null {
  if (capture === undefined) return null;
  const verified = verifyOpenSemanticFactorFormationCapture(capture, sha256);
  if (verified.graph !== null && verified.graph.source_kind !== "evidence") {
    throw new Error("evidence semantic factor formation must contain an evidence graph");
  }
  if (verified.source_sha256 !== null &&
      verified.source_sha256 !== sourceDigest(capsule.excerpt)) {
    throw new Error("semantic factor formation source does not match its evidence capsule");
  }
  return [
    capsule.object_id,
    capsule.workspace_id,
    verified.schema_version,
    verified.operator_id,
    verified.status,
    verified.producer_operator_id,
    verified.source_sha256,
    verified.graph === null ? null : JSON.stringify(verified.graph),
    verified.capture_digest
  ];
}

function sourceDigest(source: string | null): string | null {
  return source === null ? null : `sha256:${sha256(source)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
