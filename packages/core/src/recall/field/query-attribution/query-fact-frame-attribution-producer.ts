import {
  groundAssociativeFactFrame,
  type AssociativeFactFrame,
  type AssociativeFactSlotRole
} from "@do-soul/alaya-protocol";
import type { QueryFactFrameExtractionPort } from
  "../../../shared/query-fact-frame-extraction-port.js";
import type { RecallQueryDemand } from "../../query/recall-query-demand.js";
import {
  createRecallQueryFieldAttributionContribution,
  type RecallQueryFieldAttributionContribution
} from "./query-field-attribution.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../field-identity.js";
import {
  projectFactFrameSemanticFactors,
  type FactFrameSemanticFactor
} from "../fact-frame-semantic-factors.js";

export const RECALL_QUERY_FACT_FRAME_MAX_FRAMES = 8;
export const QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID =
  "query_fact_frame_extraction_capture_v1";

export type RecallQueryFactFrameExtractionStatus =
  | "returned"
  | "ineligible"
  | "unavailable";

export type RecallQueryFactFrameSlotCapture = Readonly<{
  readonly role: AssociativeFactSlotRole;
  readonly text: string;
  readonly source_offset: readonly [number, number];
}>;

export type RecallQueryFactFrameCaptureFrame = Readonly<{
  readonly schema_version: 1;
  readonly slots: readonly Readonly<RecallQueryFactFrameSlotCapture>[];
}>;

export type RecallQueryFactFrameExtractionCapture = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID;
  readonly status: RecallQueryFactFrameExtractionStatus;
  readonly query_text_digest: RecallFieldDigest;
  readonly producer_operator_id: string | null;
  readonly frames: readonly Readonly<RecallQueryFactFrameCaptureFrame>[];
  readonly capture_digest: RecallFieldDigest;
}>;

export async function captureRecallQueryFactFrames(params: Readonly<{
  readonly query_text: string | null;
  readonly port?: QueryFactFrameExtractionPort;
  readonly on_failure?: (error: unknown) => void;
}>): Promise<RecallQueryFactFrameExtractionCapture> {
  const queryDigest = digestRecallFieldIdentity({ query_text: params.query_text });
  if (params.query_text === null) {
    return createCapture("ineligible", queryDigest, null, []);
  }
  if (params.port === undefined) {
    return createCapture("unavailable", queryDigest, null, []);
  }
  try {
    const producerId = canonicalProducerId(params.port.operator_id);
    const frames = await params.port.extract(params.query_text, {
      maxFrames: RECALL_QUERY_FACT_FRAME_MAX_FRAMES
    });
    if (frames.length > RECALL_QUERY_FACT_FRAME_MAX_FRAMES) {
      throw new Error("query fact-frame extractor exceeded its frame bound");
    }
    return createCapture(
      "returned",
      queryDigest,
      producerId,
      canonicalizeFrames(params.query_text, frames)
    );
  } catch (error) {
    params.on_failure?.(error);
    return createCapture("unavailable", queryDigest, null, []);
  }
}

export function createUnavailableRecallQueryFactFrameCapture(
  queryText: string | null
): RecallQueryFactFrameExtractionCapture {
  return createCapture(
    queryText === null ? "ineligible" : "unavailable",
    digestRecallFieldIdentity({ query_text: queryText }),
    null,
    []
  );
}

export function produceRelationQueryFieldAttributionContribution(params: Readonly<{
  readonly query_text: string | null;
  readonly query_demand: Readonly<RecallQueryDemand>;
  readonly capture: Readonly<RecallQueryFactFrameExtractionCapture>;
}>): RecallQueryFieldAttributionContribution | undefined {
  verifyRecallQueryFactFrameExtractionCapture(params.capture);
  if (params.query_text === null || params.capture.status !== "returned" ||
      params.capture.producer_operator_id === null ||
      params.capture.query_text_digest !== digestRecallFieldIdentity({
        query_text: params.query_text
      })) {
    return undefined;
  }
  verifyCapturedFramesAgainstQuery(params.capture.frames, params.query_text);
  const sourceSpansByValue = indexRelationSourceSpans(params.capture.frames);
  const attributions = params.query_demand.atoms.flatMap((atom) => {
    const sourceSpans = sourceSpansByValue.get(atom.value);
    return (atom.kind === "lexical_term" || atom.kind === "phrase") &&
      sourceSpans !== undefined
      ? [{
          query_atom_id: atom.id,
          role: "relation" as const,
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

export function collectRelationDemandTermsFromFactFrameCapture(
  capture: Readonly<RecallQueryFactFrameExtractionCapture>
): readonly string[] {
  verifyRecallQueryFactFrameExtractionCapture(capture);
  if (capture.status !== "returned") return Object.freeze([]);
  const terms = new Map<string, string>();
  for (const frame of capture.frames) {
    for (const slot of frame.slots) {
      if (slot.role !== "relation") continue;
      const normalized = normalizeDemandValue(slot.text);
      if (!terms.has(normalized)) terms.set(normalized, slot.text);
    }
  }
  return Object.freeze([...terms.values()]);
}

export function collectFactFrameSemanticFactorsFromCapture(
  capture: Readonly<RecallQueryFactFrameExtractionCapture>
): readonly Readonly<FactFrameSemanticFactor>[] {
  verifyRecallQueryFactFrameExtractionCapture(capture);
  if (capture.status !== "returned") return Object.freeze([]);
  return Object.freeze(capture.frames.flatMap((frame, frameIndex) =>
    projectFactFrameSemanticFactors(frame.slots, frameIndex)
  ));
}

export function verifyRecallQueryFactFrameExtractionCapture(
  capture: Readonly<RecallQueryFactFrameExtractionCapture>
): void {
  if (capture.schema_version !== 1 ||
      capture.operator_id !== QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID ||
      !EXTRACTION_STATUSES.has(capture.status)) {
    throw new Error("query fact-frame extraction capture contract mismatch");
  }
  assertSha256(capture.query_text_digest, "query fact-frame query digest");
  if ((capture.status === "returned") !==
      (capture.producer_operator_id !== null)) {
    throw new Error("query fact-frame producer identity does not match status");
  }
  if (capture.status !== "returned" && capture.frames.length !== 0) {
    throw new Error("non-returned query fact-frame capture cannot contain frames");
  }
  validateCapturedFrameShapes(capture.frames);
  const { capture_digest: _digest, ...body } = capture;
  if (digestRecallFieldIdentity(body) !== capture.capture_digest) {
    throw new Error("query fact-frame extraction capture digest mismatch");
  }
}

function canonicalizeFrames(
  queryText: string,
  frames: readonly Readonly<AssociativeFactFrame>[]
): readonly Readonly<RecallQueryFactFrameCaptureFrame>[] {
  const byDigest = new Map<string, Readonly<RecallQueryFactFrameCaptureFrame>>();
  for (const frame of frames) {
    const grounded = groundAssociativeFactFrame(frame, queryText);
    if (grounded === null) {
      throw new Error("query fact-frame extractor returned an ungrounded frame");
    }
    const captured = captureGroundedFrame(queryText, grounded);
    byDigest.set(digestRecallFieldIdentity(captured), captured);
  }
  return Object.freeze([...byDigest.values()].sort(compareCapturedFrames));
}

function captureGroundedFrame(
  queryText: string,
  frame: Readonly<AssociativeFactFrame>
): Readonly<RecallQueryFactFrameCaptureFrame> {
  let cursor = 0;
  const slots = frame.slots.map((slot) => {
    const start = queryText.indexOf(slot.text, cursor);
    if (start < 0) throw new Error("query fact-frame slot is not source-exact");
    const end = start + slot.text.length;
    cursor = end;
    return Object.freeze({
      role: slot.role,
      text: slot.text,
      source_offset: Object.freeze([start, end]) as readonly [number, number]
    });
  });
  return Object.freeze({ schema_version: 1, slots: Object.freeze(slots) });
}

function createCapture(
  status: RecallQueryFactFrameExtractionStatus,
  queryTextDigest: RecallFieldDigest,
  producerOperatorId: string | null,
  frames: readonly Readonly<RecallQueryFactFrameCaptureFrame>[]
): RecallQueryFactFrameExtractionCapture {
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID,
    status,
    query_text_digest: queryTextDigest,
    producer_operator_id: producerOperatorId,
    frames: Object.freeze([...frames])
  });
  return Object.freeze({ ...body, capture_digest: digestRecallFieldIdentity(body) });
}

function validateCapturedFrameShapes(
  frames: readonly Readonly<RecallQueryFactFrameCaptureFrame>[]
): void {
  if (frames.length > RECALL_QUERY_FACT_FRAME_MAX_FRAMES) {
    throw new Error("query fact-frame capture exceeded its frame bound");
  }
  for (const frame of frames) {
    const roles = new Set(frame.slots.map(({ role }) => role));
    if (frame.schema_version !== 1 || frame.slots.length < 3 ||
        frame.slots.length > 6 ||
        !REQUIRED_ROLES.every((role) => roles.has(role))) {
      throw new Error("query fact-frame capture frame is invalid");
    }
    for (const slot of frame.slots) validateCapturedSlot(slot);
  }
}

function validateCapturedSlot(slot: Readonly<RecallQueryFactFrameSlotCapture>): void {
  const [start, end] = slot.source_offset;
  if (!SLOT_ROLES.has(slot.role) || slot.text.trim().length === 0 ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end <= start) {
    throw new Error("query fact-frame capture slot is invalid");
  }
}

function verifyCapturedFramesAgainstQuery(
  frames: readonly Readonly<RecallQueryFactFrameCaptureFrame>[],
  queryText: string
): void {
  for (const frame of frames) {
    let cursor = 0;
    for (const slot of frame.slots) {
      const [start, end] = slot.source_offset;
      if (start < cursor || end > queryText.length ||
          queryText.slice(start, end) !== slot.text) {
        throw new Error("query fact-frame capture is not source-exact");
      }
      cursor = end;
    }
  }
}

function indexRelationSourceSpans(
  frames: readonly Readonly<RecallQueryFactFrameCaptureFrame>[]
): ReadonlyMap<string, readonly (readonly [number, number])[]> {
  const indexed = new Map<string, Map<string, readonly [number, number]>>();
  for (const { slots } of frames) {
    for (const slot of slots) {
      if (slot.role !== "relation") continue;
      const value = normalizeDemandValue(slot.text);
      const spans = indexed.get(value) ?? new Map();
      const [start, end] = slot.source_offset;
      spans.set(`${start}:${end}`, Object.freeze([start, end] as const));
      indexed.set(value, spans);
    }
  }
  return new Map([...indexed].map(([value, spans]) => [
    value,
    Object.freeze([...spans.values()].sort(compareSpans))
  ]));
}

function compareCapturedFrames(
  left: Readonly<RecallQueryFactFrameCaptureFrame>,
  right: Readonly<RecallQueryFactFrameCaptureFrame>
): number {
  const leftStart = left.slots[0]?.source_offset[0] ?? 0;
  const rightStart = right.slots[0]?.source_offset[0] ?? 0;
  return leftStart - rightStart ||
    digestRecallFieldIdentity(left).localeCompare(digestRecallFieldIdentity(right));
}

function compareSpans(
  left: readonly [number, number],
  right: readonly [number, number]
): number {
  return left[0] - right[0] || left[1] - right[1];
}

function canonicalProducerId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized !== value) {
    throw new Error("query fact-frame producer identity must be canonical");
  }
  return normalized;
}

function assertSha256(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
}

function normalizeDemandValue(value: string): string {
  return value.trim().replace(/[.]+$/u, "").replace(/\s+/gu, " ").toLocaleLowerCase();
}

const REQUIRED_ROLES: readonly AssociativeFactSlotRole[] =
  ["subject", "relation", "value"];
const SLOT_ROLES: ReadonlySet<string> = new Set([
  "subject", "relation", "value", "qualifier", "time"
]);
const EXTRACTION_STATUSES: ReadonlySet<string> = new Set([
  "returned", "ineligible", "unavailable"
]);
