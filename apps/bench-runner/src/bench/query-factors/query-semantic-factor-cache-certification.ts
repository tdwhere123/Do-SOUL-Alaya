import { createHash } from "node:crypto";
import {
  certifyQueryOsfSemanticCompleteness,
  openSemanticFactorFormationCapturePreimage,
  type CertifiedQueryOsfGraph,
  type OpenSemanticFactorFormationCapture,
  type QueryFactFrameOsfObligation,
  type QueryOsfSemanticCompletenessReceipt
} from "@do-soul/alaya-protocol";
import {
  RuleBasedQueryFactFrameExtractor,
  captureRecallQueryFactFrames,
  deriveQueryFactFrameOsfObligation,
  materializeOpenSemanticFactorFormation
} from "@do-soul/alaya-core";
import { OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID } from "@do-soul/alaya-soul";

export type CertifiedQueryCacheValue = Readonly<{
  capture: OpenSemanticFactorFormationCapture;
  receipt: QueryOsfSemanticCompletenessReceipt | null;
}>;

export async function compileCertifiedQueryCacheValue(input: Readonly<{
  sourceText: string;
  compile: (
    sourceText: string,
    obligation: Readonly<QueryFactFrameOsfObligation>
  ) => Promise<Readonly<CertifiedQueryOsfGraph> | null>;
}>): Promise<CertifiedQueryCacheValue> {
  const obligation = await deriveObligation(input.sourceText);
  if (obligation === null) return unavailable(input.sourceText);
  const certified = await input.compile(input.sourceText, obligation);
  if (certified === null) return unavailable(input.sourceText);
  const expected = certifyQueryOsfSemanticCompleteness({
    query_text: input.sourceText, graph: certified.graph, obligation,
    producer_operator_id: certified.producer_operator_id, sha256
  });
  if (expected === null || JSON.stringify(expected) !==
      JSON.stringify(certified.semantic_completeness_receipt)) {
    throw new Error("query semantic factor compiler emitted an invalid completeness receipt");
  }
  const capture = materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: input.sourceText,
    proposal: { schema_version: 1,
      producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
      source_text: input.sourceText, graph: certified.graph }
  });
  if (capture.status !== "formed") {
    throw new Error("query semantic factor compiler emitted an invalid capture");
  }
  return { capture, receipt: expected };
}

export async function verifyCertifiedQueryCacheValue(
  sourceText: string,
  value: CertifiedQueryCacheValue
): Promise<void> {
  const obligation = await deriveObligation(sourceText);
  if (obligation === null) {
    if (value.capture.status !== "unavailable" || value.receipt !== null) fail();
    return;
  }
  if (value.capture.status === "unavailable" && value.receipt === null) return;
  if (value.capture.status !== "formed" || value.capture.graph === null ||
      value.receipt === null) fail();
  const expected = certifyQueryOsfSemanticCompleteness({
    query_text: sourceText, graph: value.capture.graph, obligation,
    producer_operator_id: value.capture.producer_operator_id ?? "", sha256
  });
  if (expected === null || JSON.stringify(expected) !== JSON.stringify(value.receipt)) fail();
}

export async function verifyQuerySemanticFactorCacheEntry(
  sourceText: string,
  value: CertifiedQueryCacheValue
): Promise<void> {
  assertCaptureIntegrity(sourceText, value.capture);
  await verifyCertifiedQueryCacheValue(sourceText, value);
}

function assertCaptureIntegrity(
  sourceText: string,
  capture: Readonly<OpenSemanticFactorFormationCapture>
): void {
  const validStatus = capture.status === "formed" || capture.status === "unavailable";
  const formedValid = capture.status !== "formed" ||
    (capture.graph?.source_kind === "query" &&
      capture.producer_operator_id === OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID);
  const unavailableValid = capture.status !== "unavailable" ||
    (capture.graph === null && capture.producer_operator_id === null);
  const { capture_digest: _digest, ...body } = capture;
  if (!validStatus || !formedValid || !unavailableValid ||
      capture.source_sha256 !== prefixedSha256(sourceText) ||
      capture.capture_digest !== prefixedSha256(
        openSemanticFactorFormationCapturePreimage(body)
      )) {
    throw new Error("query semantic factor cache capture integrity mismatch");
  }
}

async function deriveObligation(sourceText: string) {
  const factFrameCapture = await captureRecallQueryFactFrames({
    query_text: sourceText,
    port: new RuleBasedQueryFactFrameExtractor()
  });
  return deriveQueryFactFrameOsfObligation({
    query_text: sourceText,
    fact_frame_capture: factFrameCapture
  });
}

function unavailable(sourceText: string): CertifiedQueryCacheValue {
  return {
    capture: materializeOpenSemanticFactorFormation({
      source_kind: "query", source_text: sourceText
    }),
    receipt: null
  };
}

function fail(): never {
  throw new Error("query semantic factor cache completeness receipt mismatch");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function prefixedSha256(value: string): `sha256:${string}` {
  return `sha256:${sha256(value)}`;
}
