import { createHash } from "node:crypto";
import {
  EvidenceOsfSemanticCompletenessReceiptSchema,
  verifyEvidenceOsfSemanticCompleteness,
  verifyOpenSemanticFactorFormationCapture,
  type EvidenceFactFrameFormationCapture,
  type OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";

export interface StoredSemanticFactorFormationColumns {
  readonly semantic_formation_workspace_id: string | null;
  readonly semantic_formation_schema_version: number | null;
  readonly semantic_formation_operator_id: string | null;
  readonly semantic_formation_status: string | null;
  readonly semantic_formation_producer_operator_id: string | null;
  readonly semantic_formation_source_sha256: string | null;
  readonly semantic_formation_graph_json: string | null;
  readonly semantic_formation_capture_digest: string | null;
  readonly semantic_completeness_json: string | null;
}

export function readStoredSemanticFactorFormation(
  row: Readonly<StoredSemanticFactorFormationColumns>,
  expectedWorkspaceId: string,
  expectedSourceText: string | null,
  factFrame: Readonly<EvidenceFactFrameFormationCapture> | undefined
): Readonly<OpenSemanticFactorFormationCapture> | undefined {
  if (row.semantic_formation_operator_id === null) return undefined;
  if (row.semantic_formation_workspace_id !== expectedWorkspaceId) {
    throw new Error("semantic factor formation workspace does not match its evidence");
  }
  const capture = verifyOpenSemanticFactorFormationCapture({
    schema_version: row.semantic_formation_schema_version,
    operator_id: row.semantic_formation_operator_id,
    status: row.semantic_formation_status,
    producer_operator_id: row.semantic_formation_producer_operator_id,
    source_sha256: row.semantic_formation_source_sha256,
    graph: parseGraph(row.semantic_formation_graph_json),
    capture_digest: row.semantic_formation_capture_digest
  }, sha256);
  if (capture.graph !== null && capture.graph.source_kind !== "evidence") {
    throw new Error("stored semantic factor formation is not evidence-owned");
  }
  if (capture.source_sha256 !== null &&
      capture.source_sha256 !== sourceDigest(expectedSourceText)) {
    throw new Error("semantic factor formation source does not match its evidence");
  }
  if (capture.status === "formed" && !hasCertifiedCompleteness(
    row, capture, factFrame, expectedSourceText
  )) {
    return undefined;
  }
  return capture;
}

function hasCertifiedCompleteness(
  row: Readonly<StoredSemanticFactorFormationColumns>,
  capture: Readonly<OpenSemanticFactorFormationCapture>,
  factFrame: Readonly<EvidenceFactFrameFormationCapture> | undefined,
  sourceText: string | null
): boolean {
  if (row.semantic_completeness_json === null || factFrame?.status !== "formed" ||
      sourceText === null) return false;
  try {
    verifyEvidenceOsfSemanticCompleteness({
      receipt: EvidenceOsfSemanticCompletenessReceiptSchema.parse(
        JSON.parse(row.semantic_completeness_json) as unknown
      ),
      source_text: sourceText,
      fact_frame: factFrame,
      semantic_formation: capture,
      sha256
    });
    return true;
  } catch {
    return false;
  }
}

function parseGraph(value: string | null): unknown {
  return value === null ? null : JSON.parse(value) as unknown;
}

function sourceDigest(source: string | null): string | null {
  return source === null ? null : `sha256:${sha256(source)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
