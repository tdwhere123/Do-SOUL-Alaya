import { createHash } from "node:crypto";
import {
  buildAssociativeFactKeyProjections,
  verifyEvidenceFactFrameFormationCapture,
  type EvidenceCapsule,
  type EvidenceFactFrameFormationCapture,
  type EvidenceSearchProjection
} from "@do-soul/alaya-protocol";

export type EvidenceFactFrameFormationInsertArgs = readonly [
  evidenceObjectId: string,
  workspaceId: string,
  schemaVersion: number,
  operatorId: string,
  status: string,
  producerOperatorId: string | null,
  sourceHash: string | null,
  factFrameJson: string | null,
  captureDigest: string
];

export function prepareFactFrameFormationInsert(
  capsule: Readonly<EvidenceCapsule>,
  projections: readonly Readonly<EvidenceSearchProjection>[],
  capture?: Readonly<EvidenceFactFrameFormationCapture>
): EvidenceFactFrameFormationInsertArgs | null {
  const factKeys = projections.filter(({ projection_kind: kind }) => kind === "fact_key");
  if (capture === undefined) {
    if (factKeys.length > 0) {
      throw new Error("fact-key projections require a fact-frame formation capture");
    }
    return null;
  }
  const verified = verifyEvidenceFactFrameFormationCapture(capture, sha256);
  if (verified.source_hash !== null && verified.source_hash !== capsule.source_hash) {
    throw new Error("fact-frame formation source hash does not match its evidence capsule");
  }
  const expected = verified.fact_frame === null
    ? []
    : buildAssociativeFactKeyProjections(verified.fact_frame);
  if (!sameFactKeys(factKeys, expected)) {
    throw new Error("fact-key projections do not match their fact-frame formation capture");
  }
  return [
    capsule.object_id,
    capsule.workspace_id,
    verified.schema_version,
    verified.operator_id,
    verified.status,
    verified.producer_operator_id,
    verified.source_hash,
    verified.fact_frame === null ? null : JSON.stringify(verified.fact_frame),
    verified.capture_digest
  ];
}

function sameFactKeys(
  actual: readonly Readonly<EvidenceSearchProjection>[],
  expected: readonly Readonly<EvidenceSearchProjection>[]
): boolean {
  return actual.length === expected.length && actual.every((projection, index) => {
    const expectedProjection = expected[index];
    return expectedProjection !== undefined &&
      projection.projection_id === expectedProjection.projection_id &&
      projection.projection_kind === expectedProjection.projection_kind &&
      projection.content === expectedProjection.content;
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
