import { createHash } from "node:crypto";
import {
  verifyOpenSemanticFactorFormationCapture,
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
}

export function readStoredSemanticFactorFormation(
  row: Readonly<StoredSemanticFactorFormationColumns>,
  expectedWorkspaceId: string,
  expectedSourceText: string | null
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
  return capture;
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
