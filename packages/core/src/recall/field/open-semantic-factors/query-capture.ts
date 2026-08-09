import { createHash } from "node:crypto";
import {
  OpenSemanticFactorFormationCaptureSchema,
  openSemanticFactorFormationCapturePreimage,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorFormationProposal
} from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../../semantic/open-semantic-factor-formation.js";
import type { OpenSemanticFactorExtractionPort } from
  "../../../semantic/open-semantic-factor-extraction-port.js";

export async function captureRecallQueryOpenSemanticFactors(params: Readonly<{
  readonly query_text: string | null;
  readonly port?: OpenSemanticFactorExtractionPort;
  readonly prepared_proposal?: Readonly<OpenSemanticFactorFormationProposal>;
  readonly prepared_capture?: Readonly<OpenSemanticFactorFormationCapture>;
  readonly on_failure?: (error: unknown) => void;
}>): Promise<OpenSemanticFactorFormationCapture> {
  if (params.prepared_capture !== undefined) {
    return materializePreparedCapture({
      query_text: params.query_text,
      prepared_capture: params.prepared_capture
    });
  }
  if (params.query_text === null || params.port === undefined) {
    if (params.prepared_proposal !== undefined) {
      return materializeOpenSemanticFactorFormation({
        source_kind: "query",
        source_text: params.query_text,
        proposal: params.prepared_proposal
      });
    }
    return materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: params.query_text
    });
  }
  if (params.prepared_proposal !== undefined) {
    return materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: params.query_text,
      proposal: params.prepared_proposal
    });
  }
  try {
    const graph = await params.port.extract("query", params.query_text);
    return materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: params.query_text,
      ...(graph === null ? {} : {
        proposal: {
          schema_version: 1,
          producer_operator_id: params.port.operator_id,
          source_text: params.query_text,
          graph
        }
      })
    });
  } catch (error) {
    params.on_failure?.(error);
    return materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: params.query_text
    });
  }
}

function materializePreparedCapture(params: Readonly<{
  readonly query_text: string | null;
  readonly prepared_capture: Readonly<OpenSemanticFactorFormationCapture>;
}>): OpenSemanticFactorFormationCapture {
  const parsed = OpenSemanticFactorFormationCaptureSchema.safeParse(params.prepared_capture);
  if (!parsed.success || params.query_text === null || params.query_text.trim().length === 0) {
    return materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: params.query_text,
      proposal: null
    });
  }
  const capture = parsed.data;
  const body = {
    schema_version: capture.schema_version,
    operator_id: capture.operator_id,
    status: capture.status,
    producer_operator_id: capture.producer_operator_id,
    source_sha256: capture.source_sha256,
    graph: capture.graph
  };
  const expectedDigest = `sha256:${sha256(openSemanticFactorFormationCapturePreimage(body))}`;
  if (capture.source_sha256 !== `sha256:${sha256(params.query_text)}` ||
      expectedDigest !== capture.capture_digest) {
    return materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: params.query_text,
      proposal: null
    });
  }
  return capture;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
