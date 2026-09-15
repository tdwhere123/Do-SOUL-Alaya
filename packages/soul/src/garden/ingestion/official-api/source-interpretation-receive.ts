import { createHash } from "node:crypto";
import {
  locateSourceInterpretation,
  SourceInterpretationResponseEnvelopeSchema,
  type FieldContractSha256,
  type SourceLocatedInterpretation
} from "@do-soul/alaya-protocol";
import {
  computeOfficialApiSourceCorpusIdentity,
  type OfficialApiExtractionRequest
} from "./extraction-request.js";
import {
  buildOfficialApiSourceAssertions,
  indexOfficialApiSourceAssertions
} from "../../triage/grounding/source-locator.js";

export const OFFICIAL_API_INTERPRETATION_RECEIVE_CONTRACT_VERSION = 1 as const;
export const OFFICIAL_API_INTERPRETATION_RECEIVE_PRODUCER =
  "official-api-source-interpretation-receive-v1" as const;

export type OfficialApiInterpretationReceiveStatus = "complete" | "partial";

export type OfficialApiInterpretationEntryRejectionReason =
  | "source_generation_mismatch"
  | "source_assertion_mismatch"
  | "candidate_rejected"
  | "malformed_response"
  | "missing_response"
  | "transport_unknown";

export interface OfficialApiInterpretationEntryRejection {
  readonly index: number;
  readonly reason: OfficialApiInterpretationEntryRejectionReason;
  readonly assertion_id?: number;
  readonly candidate_index?: number | null;
  readonly diagnostic_reason?: SourceLocatedInterpretation["diagnostics"][number]["reason"];
}

export interface OfficialApiInterpretationReceiveReceipt {
  readonly contract_version: typeof OFFICIAL_API_INTERPRETATION_RECEIVE_CONTRACT_VERSION;
  readonly producer: typeof OFFICIAL_API_INTERPRETATION_RECEIVE_PRODUCER;
  readonly status: OfficialApiInterpretationReceiveStatus;
  readonly located: readonly SourceLocatedInterpretation[];
  readonly rejections: readonly OfficialApiInterpretationEntryRejection[];
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function receiveOfficialApiSourceInterpretations(
  rawJson: string,
  request: OfficialApiExtractionRequest,
  input: Readonly<{
    readonly sourceCorpus: string;
    readonly artifactKey: string;
    readonly sha256?: FieldContractSha256;
    readonly responseKind?: "received" | "missing_response" | "transport_unknown";
  }>
): OfficialApiInterpretationReceiveReceipt {
  const sha256 = input.sha256 ?? sha256Utf8;
  const bound = requestBoundRejections(request, input.sourceCorpus);
  if (bound !== null) {
    return toReceipt("partial", [], bound);
  }
  if (input.responseKind === "missing_response" || input.responseKind === "transport_unknown") {
    return locateUnavailable(request, input, sha256, input.responseKind);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return locateUnavailable(request, input, sha256, "malformed_response");
  }
  const envelope = SourceInterpretationResponseEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return locateUnavailable(request, input, sha256, "malformed_response");
  }
  const indexed = new Map(
    indexOfficialApiSourceAssertions(input.sourceCorpus).map((assertion) => [
      assertion.assertion_id,
      assertion
    ])
  );
  const located: SourceLocatedInterpretation[] = [];
  const rejections: OfficialApiInterpretationEntryRejection[] = [];
  const requestedIds = new Set(request.source_assertions.map((member) => member.assertion_id));
  envelope.data.interpretations.forEach((entry, index) => {
    if (!requestedIds.has(entry.assertion_id)) {
      rejections.push({ index, assertion_id: entry.assertion_id, reason: "source_assertion_mismatch" });
    }
  });
  request.source_assertions.forEach((member, index) => {
    const catalog = indexed.get(member.assertion_id);
    if (catalog === undefined || catalog.text !== member.text) {
      rejections.push(Object.freeze({
        index,
        reason: "source_assertion_mismatch" as const,
        assertion_id: member.assertion_id
      }));
      return;
    }
    const interpretation = locateSourceInterpretation({
      source: input.sourceCorpus,
      artifactKey: input.artifactKey,
      sha256,
      assertion: {
        assertion_id: catalog.assertion_id,
        text: catalog.text,
        source_span: [catalog.start, catalog.end]
      },
      response: { kind: "received", value: envelope.data }
    });
    located.push(interpretation);
    for (const diagnostic of interpretation.diagnostics) {
      rejections.push({ index, assertion_id: member.assertion_id,
        reason: "candidate_rejected", candidate_index: diagnostic.candidate_index,
        diagnostic_reason: diagnostic.reason });
    }
  });
  return toReceipt(rejections.length === 0 ? "complete" : "partial", located, rejections);
}

/** Live ordinary extraction classifier. Historical HOLD readers keep classifyOfficialApiRequestResult. */
export function classifyOfficialApiExtractionResult(
  rawJson: string,
  request: OfficialApiExtractionRequest,
  sourceCorpus?: string
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("official API completed result requires an interpretations array");
  }
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { interpretations?: unknown }).interpretations)) {
    return classifyOfficialApiInterpretationResult(rawJson, request, sourceCorpus);
  }
  throw new Error("official API completed result requires an interpretations array");
}

export function classifyOfficialApiInterpretationResult(
  rawJson: string,
  request: OfficialApiExtractionRequest,
  sourceCorpus?: string
) {
  if (sourceCorpus === undefined) {
    throw new Error("official API completed result requires the source corpus");
  }
  if (computeOfficialApiSourceCorpusIdentity(sourceCorpus) !== request.source_corpus_identity) {
    throw new Error("official API completed result source corpus differs from its request");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("official API completed result requires an interpretations array");
  }
  const envelope = SourceInterpretationResponseEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new Error("official API completed result requires an interpretations array");
  }
  const catalogIds = new Set(
    request.source_assertions.map((assertion) => assertion.assertion_id)
  );
  if (envelope.data.interpretations.some((entry) => !catalogIds.has(entry.assertion_id))) {
    throw new Error("official API completed result contains rejected interpretation entries");
  }
  const received = receiveOfficialApiSourceInterpretations(rawJson, request, {
    sourceCorpus,
    artifactKey: "admission",
    responseKind: "received"
  });
  if (received.status !== "complete") {
    throw new Error("official API completed result contains rejected interpretation entries");
  }
  const failed = received.located.some((item) => item.outcome === "failed");
  if (failed) {
    throw new Error("official API completed result contains rejected interpretation entries");
  }
  const hasCandidates = received.located.some((item) => item.outcome === "candidates");
  if (envelope.data.interpretations.length === 0) {
    return Object.freeze({
      status: "completed_empty" as const,
      located: received.located
    });
  }
  if (!hasCandidates) {
    throw new Error("official API completed result contains rejected interpretation entries");
  }
  return Object.freeze({
    status: "completed_signals" as const,
    located: received.located
  });
}

function requestBoundRejections(
  request: OfficialApiExtractionRequest,
  sourceCorpus: string
): readonly OfficialApiInterpretationEntryRejection[] | null {
  if (computeOfficialApiSourceCorpusIdentity(sourceCorpus) !== request.source_corpus_identity) {
    return request.source_assertions.map((_, index) => Object.freeze({
      index,
      reason: "source_generation_mismatch" as const
    }));
  }
  const catalog = new Map(buildOfficialApiSourceAssertions(sourceCorpus)
    .map((assertion) => [assertion.assertion_id, assertion.text]));
  if (request.source_assertions.some((assertion) => catalog.get(assertion.assertion_id) !== assertion.text)) {
    return request.source_assertions.map((assertion, index) => Object.freeze({
      index,
      reason: "source_assertion_mismatch" as const,
      assertion_id: assertion.assertion_id
    }));
  }
  return null;
}

function locateUnavailable(
  request: OfficialApiExtractionRequest,
  input: Readonly<{
    readonly sourceCorpus: string;
    readonly artifactKey: string;
  }>,
  sha256: FieldContractSha256,
  reason: "malformed_response" | "missing_response" | "transport_unknown"
): OfficialApiInterpretationReceiveReceipt {
  const indexed = new Map(
    indexOfficialApiSourceAssertions(input.sourceCorpus).map((assertion) => [
      assertion.assertion_id,
      assertion
    ])
  );
  const located: SourceLocatedInterpretation[] = [];
  const rejections: OfficialApiInterpretationEntryRejection[] = [];
  request.source_assertions.forEach((member, index) => {
    const catalog = indexed.get(member.assertion_id);
    if (catalog === undefined || catalog.text !== member.text) {
      rejections.push(Object.freeze({
        index,
        reason: "source_assertion_mismatch" as const,
        assertion_id: member.assertion_id
      }));
      return;
    }
    located.push(locateSourceInterpretation({
      source: input.sourceCorpus,
      artifactKey: input.artifactKey,
      sha256,
      assertion: {
        assertion_id: catalog.assertion_id,
        text: catalog.text,
        source_span: [catalog.start, catalog.end]
      },
      response: reason === "malformed_response"
        ? { kind: "received", value: {} }
        : { kind: "unavailable", reason }
    }));
    rejections.push(Object.freeze({
      index,
      reason,
      assertion_id: member.assertion_id
    }));
  });
  return toReceipt("partial", located, rejections);
}

function toReceipt(
  status: OfficialApiInterpretationReceiveStatus,
  located: readonly SourceLocatedInterpretation[],
  rejections: readonly OfficialApiInterpretationEntryRejection[]
): OfficialApiInterpretationReceiveReceipt {
  return Object.freeze({
    contract_version: OFFICIAL_API_INTERPRETATION_RECEIVE_CONTRACT_VERSION,
    producer: OFFICIAL_API_INTERPRETATION_RECEIVE_PRODUCER,
    status: rejections.length > 0 ? "partial" : status,
    located: Object.freeze([...located]),
    rejections: Object.freeze([...rejections])
  });
}
