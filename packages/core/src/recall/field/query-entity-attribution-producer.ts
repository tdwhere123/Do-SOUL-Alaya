import type {
  EntityCandidate,
  EntityExtractionPort
} from "../../shared/entity-extraction-port.js";
import type { RecallQueryDemand } from "../query/recall-query-demand.js";
import {
  aggregateRecallQueryFieldAttributionContributions,
  createRecallQueryFieldAttributionContribution,
  type RecallQueryFieldAttributionContribution,
  type RecallQueryFieldAttributionReceipt
} from "./query-attribution/query-field-attribution.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "./field-identity.js";

export const RECALL_QUERY_ENTITY_EXTRACTION_MAX_ENTITIES = 24;
export const QUERY_ENTITY_EXTRACTION_CAPTURE_OPERATOR_ID =
  "query_entity_extraction_capture_v1";

export type RecallQueryEntityExtractionStatus =
  | "returned"
  | "ineligible"
  | "unavailable";

export type RecallQueryEntityExtractionCapture = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof QUERY_ENTITY_EXTRACTION_CAPTURE_OPERATOR_ID;
  readonly status: RecallQueryEntityExtractionStatus;
  readonly query_text_digest: RecallFieldDigest;
  readonly producer_operator_id: string | null;
  readonly candidates: readonly Readonly<EntityCandidate>[];
  readonly capture_digest: RecallFieldDigest;
}>;

export async function captureRecallQueryEntities(params: Readonly<{
  readonly query_text: string | null;
  readonly port?: EntityExtractionPort;
  readonly on_failure?: (error: unknown) => void;
}>): Promise<RecallQueryEntityExtractionCapture> {
  const queryDigest = digestRecallFieldIdentity({ query_text: params.query_text });
  if (params.query_text === null) {
    return createCapture("ineligible", queryDigest, null, []);
  }
  if (params.port === undefined) {
    return createCapture("unavailable", queryDigest, null, []);
  }
  try {
    const candidates = await params.port.extract(params.query_text, {
      maxEntities: RECALL_QUERY_ENTITY_EXTRACTION_MAX_ENTITIES
    });
    return createCapture(
      "returned",
      queryDigest,
      canonicalProducerId(params.port.operator_id),
      validateCandidates(params.query_text, candidates)
    );
  } catch (error) {
    params.on_failure?.(error);
    return createCapture(
      "unavailable",
      queryDigest,
      canonicalProducerId(params.port.operator_id),
      []
    );
  }
}

export function produceEntityQueryFieldAttribution(params: Readonly<{
  readonly query_text: string | null;
  readonly query_demand: Readonly<RecallQueryDemand>;
  readonly capture: Readonly<RecallQueryEntityExtractionCapture>;
}>): RecallQueryFieldAttributionReceipt | undefined {
  const contribution = produceEntityQueryFieldAttributionContribution(params);
  return contribution === undefined
    ? undefined
    : aggregateRecallQueryFieldAttributionContributions({
        query_demand: params.query_demand,
        contributions: [contribution]
      });
}

export function produceEntityQueryFieldAttributionContribution(params: Readonly<{
  readonly query_text: string | null;
  readonly query_demand: Readonly<RecallQueryDemand>;
  readonly capture: Readonly<RecallQueryEntityExtractionCapture>;
}>): RecallQueryFieldAttributionContribution | undefined {
  verifyRecallQueryEntityExtractionCapture(params.capture);
  if (params.capture.status !== "returned" ||
      params.capture.producer_operator_id === null ||
      params.query_text === null ||
      params.capture.query_text_digest !== digestRecallFieldIdentity({
        query_text: params.query_text
      })) {
    return undefined;
  }
  const sourceSpansByValue = indexEntitySourceSpans(params.capture.candidates);
  const attributions = params.query_demand.atoms.flatMap((atom) => {
    const sourceSpans = sourceSpansByValue.get(atom.value);
    return (atom.kind === "lexical_term" || atom.kind === "phrase") &&
      sourceSpans !== undefined
      ? [{
          query_atom_id: atom.id,
          role: "entity" as const,
          source_spans: sourceSpans
        }]
      : [];
  });
  return createRecallQueryFieldAttributionContribution({
    producer_operator_id: params.capture.producer_operator_id,
    producer_capture_digest: params.capture.capture_digest,
    query_demand: params.query_demand,
    attributions
  });
}

export function verifyRecallQueryEntityExtractionCapture(
  capture: Readonly<RecallQueryEntityExtractionCapture>
): void {
  if (capture.schema_version !== 1 ||
      capture.operator_id !== QUERY_ENTITY_EXTRACTION_CAPTURE_OPERATOR_ID) {
    throw new Error("query entity extraction capture schema or operator mismatch");
  }
  if (!ENTITY_EXTRACTION_STATUSES.has(capture.status)) {
    throw new Error("query entity extraction capture status is invalid");
  }
  if ((capture.status === "returned") !==
      (capture.producer_operator_id !== null)) {
    throw new Error("query entity extraction producer identity does not match status");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(capture.query_text_digest)) {
    throw new Error("query entity extraction query digest must be sha256");
  }
  if (capture.status !== "returned" && capture.candidates.length !== 0) {
    throw new Error("non-returned query entity extraction cannot contain candidates");
  }
  const { capture_digest: _digest, ...body } = capture;
  if (digestRecallFieldIdentity(body) !== capture.capture_digest) {
    throw new Error("query entity extraction capture digest mismatch");
  }
}

function createCapture(
  status: RecallQueryEntityExtractionStatus,
  queryTextDigest: RecallFieldDigest,
  producerOperatorId: string | null,
  candidates: readonly Readonly<EntityCandidate>[]
): RecallQueryEntityExtractionCapture {
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_ENTITY_EXTRACTION_CAPTURE_OPERATOR_ID,
    status,
    query_text_digest: queryTextDigest,
    producer_operator_id: producerOperatorId,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({
      ...candidate,
      ...(candidate.source_offset === undefined
        ? {}
        : { source_offset: Object.freeze([...candidate.source_offset]) as readonly [number, number] })
    })))
  });
  return Object.freeze({ ...body, capture_digest: digestRecallFieldIdentity(body) });
}

function validateCandidates(
  queryText: string,
  candidates: readonly Readonly<EntityCandidate>[]
): readonly Readonly<EntityCandidate>[] {
  return candidates.map((candidate) => {
    if (candidate.surface.trim().length === 0 ||
        candidate.normalized !== normalizeEntityValue(candidate.surface) ||
        !ENTITY_CANDIDATE_KINDS.has(candidate.kind) ||
        !Number.isFinite(candidate.confidence) ||
        candidate.confidence < 0 || candidate.confidence > 1) {
      throw new Error("query entity extraction returned an invalid candidate");
    }
    if (candidate.source_offset !== undefined &&
        !isExactSourceSpan(queryText, candidate.surface, candidate.source_offset)) {
      throw new Error("query entity extraction candidate span is not source-exact");
    }
    return candidate;
  });
}

function isExactSourceSpan(
  queryText: string,
  surface: string,
  span: readonly [number, number]
): boolean {
  return Number.isInteger(span[0]) && Number.isInteger(span[1]) &&
    span[0] >= 0 && span[1] > span[0] && span[1] <= queryText.length &&
    queryText.slice(span[0], span[1]) === surface;
}

function indexEntitySourceSpans(
  candidates: readonly Readonly<EntityCandidate>[]
): ReadonlyMap<string, readonly (readonly [number, number])[]> {
  const indexed = new Map<string, Map<string, readonly [number, number]>>();
  for (const candidate of candidates) {
    if (candidate.source_offset === undefined) continue;
    const value = normalizeDemandValue(candidate.normalized);
    const spans = indexed.get(value) ?? new Map();
    const [start, end] = candidate.source_offset;
    spans.set(`${start}:${end}`, Object.freeze([start, end] as const));
    indexed.set(value, spans);
  }
  return new Map([...indexed].map(([value, spans]) => [
    value,
    Object.freeze([...spans.values()])
  ]));
}

function canonicalProducerId(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function normalizeEntityValue(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function normalizeDemandValue(value: string): string {
  return value.trim().replace(/[.]+$/u, "").replace(/\s+/gu, " ").toLocaleLowerCase();
}

const ENTITY_EXTRACTION_STATUSES: ReadonlySet<string> = new Set([
  "returned",
  "ineligible",
  "unavailable"
]);
const ENTITY_CANDIDATE_KINDS: ReadonlySet<string> = new Set([
  "quoted",
  "proper_noun",
  "code_ref",
  "path",
  "package",
  "task_ref",
  "cjk_phrase",
  "unknown"
]);
