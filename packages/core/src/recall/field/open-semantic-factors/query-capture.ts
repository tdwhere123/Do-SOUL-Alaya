import { createHash } from "node:crypto";
import {
  OpenSemanticFactorFormationCaptureSchema,
  QueryOsfSemanticCompletenessReceiptSchema,
  certifyQueryOsfSemanticCompleteness,
  openSemanticFactorFormationCapturePreimage,
  type OpenSemanticFactorFormationCapture,
  type QueryFactFrameOsfObligation,
  type QueryOsfSemanticCompletenessReceipt
} from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../../semantic/open-semantic-factor-formation.js";
import type { OpenSemanticFactorExtractionPort } from
  "../../../semantic/open-semantic-factor-extraction-port.js";

export async function captureCertifiedRecallQueryOpenSemanticFactors(params: Readonly<{
  readonly query_text: string | null;
  readonly obligation: Readonly<QueryFactFrameOsfObligation> | null;
  readonly port?: OpenSemanticFactorExtractionPort;
  readonly prepared_capture?: Readonly<OpenSemanticFactorFormationCapture>;
  readonly prepared_receipt?: Readonly<QueryOsfSemanticCompletenessReceipt> | null;
  readonly on_failure?: (error: unknown) => void;
}>): Promise<Readonly<{
  formation: OpenSemanticFactorFormationCapture;
  receipt: QueryOsfSemanticCompletenessReceipt | null;
}>> {
  if (params.query_text === null || params.obligation === null) {
    return unavailableCertified(params.query_text);
  }
  const certifiedParams = { ...params, query_text: params.query_text,
    obligation: params.obligation };
  if (params.prepared_capture !== undefined || params.prepared_receipt !== undefined) {
    return verifyPreparedCertified(certifiedParams);
  }
  const port = params.port;
  const extractCertifiedQuery = port?.extractCertifiedQuery;
  if (port === undefined || extractCertifiedQuery === undefined) {
    return unavailableCertified(params.query_text);
  }
  return captureLiveCertified({
    ...certifiedParams, port, extractCertifiedQuery
  });
}

async function captureLiveCertified(params: Readonly<{
  query_text: string;
  obligation: Readonly<QueryFactFrameOsfObligation>;
  port: OpenSemanticFactorExtractionPort;
  extractCertifiedQuery: NonNullable<OpenSemanticFactorExtractionPort["extractCertifiedQuery"]>;
  on_failure?: (error: unknown) => void;
}>) {
  try {
    const certified = await params.extractCertifiedQuery.call(
      params.port,
      params.query_text, params.obligation
    );
    if (certified === null) return unavailableCertified(params.query_text);
    const expected = certifyQueryOsfSemanticCompleteness({
      query_text: params.query_text,
      graph: certified.graph,
      obligation: params.obligation,
      producer_operator_id: certified.producer_operator_id,
      sha256
    });
    if (!receiptMatches(expected, certified.semantic_completeness_receipt)) {
      return unavailableCertified(params.query_text);
    }
    return {
      formation: materializeOpenSemanticFactorFormation({
        source_kind: "query", source_text: params.query_text,
        proposal: { schema_version: 1, producer_operator_id: certified.producer_operator_id,
          source_text: params.query_text, graph: certified.graph }
      }),
      receipt: expected
    };
  } catch (error) {
    params.on_failure?.(error);
    return unavailableCertified(params.query_text);
  }
}

function verifyPreparedCertified(params: Readonly<{
  query_text: string;
  obligation: Readonly<QueryFactFrameOsfObligation>;
  prepared_capture?: Readonly<OpenSemanticFactorFormationCapture>;
  prepared_receipt?: Readonly<QueryOsfSemanticCompletenessReceipt> | null;
}>) {
  if (params.prepared_capture === undefined || params.prepared_receipt == null) {
    return unavailableCertified(params.query_text);
  }
  const formation = materializePreparedCapture({
    query_text: params.query_text, prepared_capture: params.prepared_capture
  });
  if (formation.status !== "formed" || formation.graph === null) {
    return unavailableCertified(params.query_text);
  }
  const expected = certifyQueryOsfSemanticCompleteness({
    query_text: params.query_text, graph: formation.graph,
    obligation: params.obligation,
    producer_operator_id: formation.producer_operator_id ?? "", sha256
  });
  return receiptMatches(expected, params.prepared_receipt)
    ? { formation, receipt: expected }
    : unavailableCertified(params.query_text);
}

function receiptMatches(
  expected: QueryOsfSemanticCompletenessReceipt | null,
  received: Readonly<QueryOsfSemanticCompletenessReceipt>
): expected is QueryOsfSemanticCompletenessReceipt {
  if (expected === null) return false;
  const parsed = QueryOsfSemanticCompletenessReceiptSchema.safeParse(received);
  return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(expected);
}

function unavailableCertified(queryText: string | null) {
  return {
    formation: materializeOpenSemanticFactorFormation({
      source_kind: "query", source_text: queryText
    }),
    receipt: null
  };
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
