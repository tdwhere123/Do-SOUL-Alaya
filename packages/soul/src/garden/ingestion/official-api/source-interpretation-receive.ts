import { createHash } from "node:crypto";
import { z } from "zod";
import {
  locateSourceInterpretation,
  SourceInterpretationResponseEnvelopeSchema,
  SourceLocatedInterpretationSchema,
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

type OfficialApiInterpretationReceiveStatus = "complete" | "partial";

export const OfficialApiInterpretationEntryRejectionSchema = z.object({
  index: z.number().int().nonnegative().safe(),
  index_scope: z.enum(["envelope", "request"]).optional(),
  reason: z.enum(["source_generation_mismatch", "source_assertion_mismatch", "candidate_rejected",
    "malformed_response", "missing_response", "transport_unknown"]),
  assertion_id: z.number().int().positive().safe().optional(),
  candidate_index: z.number().int().nonnegative().safe().nullable().optional(),
  diagnostic_reason: SourceLocatedInterpretationSchema.unwrap().shape.diagnostics.unwrap()
    .element.unwrap().shape.reason.optional()
}).strict();
export type OfficialApiInterpretationEntryRejection = z.infer<typeof OfficialApiInterpretationEntryRejectionSchema>;

export interface OfficialApiInterpretationReceiveReceipt {
  readonly contract_version: typeof OFFICIAL_API_INTERPRETATION_RECEIVE_CONTRACT_VERSION;
  readonly producer: typeof OFFICIAL_API_INTERPRETATION_RECEIVE_PRODUCER;
  readonly status: OfficialApiInterpretationReceiveStatus;
  readonly located: readonly SourceLocatedInterpretation[];
  readonly rejections: readonly OfficialApiInterpretationEntryRejection[];
  /** Original packed membership, including members rejected before location. */
  readonly request_assertion_ids: readonly number[];
}

/** Classification refusal that keeps the receive receipt as the diagnostic authority. */
export class OfficialApiInterpretationAdmissionError extends Error {
  readonly receive: OfficialApiInterpretationReceiveReceipt;

  constructor(message: string, receive: OfficialApiInterpretationReceiveReceipt) {
    super(message);
    this.name = "OfficialApiInterpretationAdmissionError";
    this.receive = receive;
  }
}

function sha256Utf8(value: string): string {
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
    return toReceipt("partial", [], bound, request);
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
      rejections.push({
        index,
        index_scope: "envelope",
        assertion_id: entry.assertion_id,
        reason: "source_assertion_mismatch"
      });
    }
  });
  request.source_assertions.forEach((member, index) => {
    const catalog = indexed.get(member.assertion_id);
    if (catalog === undefined || catalog.text !== member.text) {
      rejections.push(Object.freeze({
        index,
        index_scope: "request" as const,
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
      rejections.push({
        index,
        index_scope: "request",
        assertion_id: member.assertion_id,
        reason: "candidate_rejected",
        candidate_index: diagnostic.candidate_index,
        diagnostic_reason: diagnostic.reason
      });
    }
  });
  return toReceipt(rejections.length === 0 ? "complete" : "partial", located, rejections, request);
}

/** Live ordinary extraction classifier. Historical HOLD readers keep classifyOfficialApiRequestResult. */
export function classifyOfficialApiExtractionResult(
  rawJson: string,
  request: OfficialApiExtractionRequest,
  sourceCorpus?: string
) {
  return classifyOfficialApiInterpretationResult(rawJson, request, sourceCorpus);
}

export function classifyOfficialApiInterpretationResult(
  rawJson: string,
  request: OfficialApiExtractionRequest,
  sourceCorpus?: string
) {
  if (sourceCorpus === undefined) {
    throw new Error("official API completed result requires the source corpus");
  }
  const received = receiveOfficialApiSourceInterpretations(rawJson, request, {
    sourceCorpus,
    artifactKey: "admission",
    responseKind: "received"
  });
  if (received.status !== "complete") {
    throw new OfficialApiInterpretationAdmissionError(
      classificationRefusalMessage(received),
      received
    );
  }
  const emittedCount = countReceivedInterpretations(rawJson);
  const hasCandidates = received.located.some((item) => item.outcome === "candidates");
  if (emittedCount === 0) {
    return Object.freeze({
      status: "completed_empty" as const,
      located: received.located
    });
  }
  if (!hasCandidates) {
    throw new OfficialApiInterpretationAdmissionError(
      "official API completed result contains rejected interpretation entries",
      received
    );
  }
  return Object.freeze({
    status: "completed_signals" as const,
    located: received.located
  });
}

function classificationRefusalMessage(
  received: OfficialApiInterpretationReceiveReceipt
): string {
  if (
    received.rejections.length > 0 &&
    received.rejections.every((item) => item.reason === "source_generation_mismatch")
  ) {
    return "official API completed result source corpus differs from its request";
  }
  if (
    received.rejections.some((item) => item.reason === "malformed_response") &&
    received.rejections.every((item) =>
      item.reason === "malformed_response" || item.reason === "source_assertion_mismatch"
    )
  ) {
    return "official API completed result requires an interpretations array";
  }
  return "official API completed result contains rejected interpretation entries";
}

function countReceivedInterpretations(rawJson: string): number {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const envelope = SourceInterpretationResponseEnvelopeSchema.safeParse(parsed);
    return envelope.success ? envelope.data.interpretations.length : 0;
  } catch {
    return 0;
  }
}

function requestBoundRejections(
  request: OfficialApiExtractionRequest,
  sourceCorpus: string
): readonly OfficialApiInterpretationEntryRejection[] | null {
  if (computeOfficialApiSourceCorpusIdentity(sourceCorpus) !== request.source_corpus_identity) {
    return request.source_assertions.map((assertion, index) => Object.freeze({
      index,
      index_scope: "request" as const,
      reason: "source_generation_mismatch" as const,
      assertion_id: assertion.assertion_id
    }));
  }
  const catalog = new Map(buildOfficialApiSourceAssertions(sourceCorpus)
    .map((assertion) => [assertion.assertion_id, assertion.text]));
  if (request.source_assertions.some((assertion) => catalog.get(assertion.assertion_id) !== assertion.text)) {
    return request.source_assertions.map((assertion, index) => Object.freeze({
      index,
      index_scope: "request" as const,
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
        index_scope: "request" as const,
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
      index_scope: "request" as const,
      reason,
      assertion_id: member.assertion_id
    }));
  });
  return toReceipt("partial", located, rejections, request);
}

function toReceipt(
  status: OfficialApiInterpretationReceiveStatus,
  located: readonly SourceLocatedInterpretation[],
  rejections: readonly OfficialApiInterpretationEntryRejection[],
  request: OfficialApiExtractionRequest
): OfficialApiInterpretationReceiveReceipt {
  return Object.freeze({
    contract_version: OFFICIAL_API_INTERPRETATION_RECEIVE_CONTRACT_VERSION,
    producer: OFFICIAL_API_INTERPRETATION_RECEIVE_PRODUCER,
    status: rejections.length > 0 ? "partial" : status,
    located: Object.freeze([...located]),
    request_assertion_ids: Object.freeze(request.source_assertions.map((member) => member.assertion_id)),
    rejections: Object.freeze([...rejections])
  });
}
