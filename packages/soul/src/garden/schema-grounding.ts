import {
  CandidateMemorySignalSchema,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";

export type SchemaGroundingValidationStatus = "valid" | "deferred" | "invalid";

export interface SchemaGroundingValidationResult {
  readonly declared: boolean;
  readonly status: SchemaGroundingValidationStatus;
  readonly reasons: readonly string[];
  readonly field_count: number;
}

export interface SchemaGroundedRawPayloadInput {
  readonly rawPayload: Readonly<Record<string, unknown>>;
  readonly signalKind: CandidateMemorySignal["signal_kind"];
  readonly objectKind: string;
  readonly confidence: number;
}

interface SchemaGroundedFieldCandidate {
  readonly field_name: string;
  readonly value: string;
  readonly evidence: string;
  readonly confidence: number;
}

const SCHEMA_GROUNDING_VERSION = 1;
const MAX_FIELD_CANDIDATES = 8;
const MAX_FIELD_VALUE_CHARS = 4_000;
const MAX_FIELD_EVIDENCE_CHARS = 4_000;

export function buildSchemaGroundedRawPayload(
  input: SchemaGroundedRawPayloadInput
): Readonly<Record<string, unknown>> {
  const alreadyDeclared = declaresSchemaGrounding(input.rawPayload);
  const detectedObject = normalizeDetectedObject(
    input.rawPayload,
    input.objectKind,
    input.confidence,
    !alreadyDeclared
  );
  const fieldCandidates = normalizeFieldCandidates(
    input.rawPayload,
    input.objectKind,
    input.confidence,
    !alreadyDeclared
  );
  const validation = validateSchemaGroundingParts({
    signalObjectKind: input.objectKind,
    detectedObject,
    fieldCandidates,
    suppliedValidationResult: readRecord(input.rawPayload.validation_result)
  });

  return Object.freeze({
    ...input.rawPayload,
    schema_grounding: Object.freeze({
      version: SCHEMA_GROUNDING_VERSION,
      pipeline: Object.freeze([
        "object_detection",
        "field_detection",
        "field_value_extraction",
        "validation"
      ]),
      status: validation.status
    }),
    detected_object: detectedObject,
    field_candidates: Object.freeze(fieldCandidates),
    validation_result: Object.freeze({
      status: validation.status,
      reasons: Object.freeze(validation.reasons),
      rule_set: "alaya_internal_schema_grounding_v1"
    })
  });
}

export function normalizeSchemaGroundedSignal(
  signal: Readonly<CandidateMemorySignal>
): Readonly<CandidateMemorySignal> {
  return CandidateMemorySignalSchema.parse({
    ...signal,
    raw_payload: buildSchemaGroundedRawPayload({
      rawPayload: signal.raw_payload,
      signalKind: signal.signal_kind,
      objectKind: signal.object_kind,
      confidence: signal.confidence
    })
  });
}

export function validateSchemaGroundingForSignal(
  signal: Readonly<CandidateMemorySignal>
): SchemaGroundingValidationResult {
  if (!declaresSchemaGrounding(signal.raw_payload)) {
    return Object.freeze({
      declared: false,
      status: "valid",
      reasons: [],
      field_count: 0
    });
  }

  const detectedObject = readRecord(signal.raw_payload.detected_object);
  const fieldCandidates = readFieldCandidates(signal.raw_payload.field_candidates);
  const validation = validateSchemaGroundingParts({
    signalObjectKind: signal.object_kind,
    detectedObject,
    fieldCandidates,
    suppliedValidationResult: readRecord(signal.raw_payload.validation_result)
  });

  return Object.freeze({
    declared: true,
    ...validation,
    field_count: fieldCandidates.length
  });
}

export function readSchemaGroundedContent(
  signal: Readonly<CandidateMemorySignal>
): string | null {
  const fieldCandidates = readFieldCandidates(signal.raw_payload.field_candidates);
  const contentField = fieldCandidates.find((field) => field.field_name === fieldNameForObjectKind(signal.object_kind));
  const selected = contentField ?? fieldCandidates[0] ?? null;
  return selected === null ? null : selected.value;
}

function declaresSchemaGrounding(rawPayload: Readonly<Record<string, unknown>>): boolean {
  return (
    rawPayload.schema_grounding !== undefined ||
    rawPayload.detected_object !== undefined ||
    rawPayload.field_candidates !== undefined ||
    rawPayload.validation_result !== undefined
  );
}

function normalizeDetectedObject(
  rawPayload: Readonly<Record<string, unknown>>,
  objectKind: string,
  confidence: number,
  allowFallback: boolean
): Readonly<Record<string, unknown>> {
  const supplied = readRecord(rawPayload.detected_object);
  const suppliedObjectKind = readNonEmptyString(supplied?.object_kind);

  if (suppliedObjectKind === null && !allowFallback) {
    return Object.freeze({});
  }

  return Object.freeze({
    object_kind: suppliedObjectKind ?? objectKind,
    confidence: clampConfidence(readNumber(supplied?.confidence) ?? confidence)
  });
}

function normalizeFieldCandidates(
  rawPayload: Readonly<Record<string, unknown>>,
  objectKind: string,
  confidence: number,
  allowFallback: boolean
): readonly SchemaGroundedFieldCandidate[] {
  const supplied = readFieldCandidates(rawPayload.field_candidates);
  if (supplied.length > 0) {
    return supplied;
  }

  if (!allowFallback) {
    return [];
  }

  const value = readPrimaryPayloadText(rawPayload);
  if (value === null) {
    return [];
  }

  return [
    Object.freeze({
      field_name: fieldNameForObjectKind(objectKind),
      value: value.slice(0, MAX_FIELD_VALUE_CHARS),
      evidence: value.slice(0, MAX_FIELD_EVIDENCE_CHARS),
      confidence: clampConfidence(confidence)
    })
  ];
}

function validateSchemaGroundingParts(input: Readonly<{
  readonly signalObjectKind: string;
  readonly detectedObject: Readonly<Record<string, unknown>> | null;
  readonly fieldCandidates: readonly SchemaGroundedFieldCandidate[];
  readonly suppliedValidationResult: Readonly<Record<string, unknown>> | null;
}>): Omit<SchemaGroundingValidationResult, "declared" | "field_count"> {
  const reasons: string[] = [];
  const detectedKind = readNonEmptyString(input.detectedObject?.object_kind);
  const suppliedStatus = readNonEmptyString(input.suppliedValidationResult?.status);

  if (detectedKind === null) {
    reasons.push("detected_object.object_kind missing");
  } else if (detectedKind !== input.signalObjectKind) {
    reasons.push("detected_object.object_kind does not match signal.object_kind");
  }

  if (input.fieldCandidates.length === 0) {
    reasons.push("field_candidates missing");
  }

  for (const [index, field] of input.fieldCandidates.entries()) {
    if (field.field_name.length === 0) {
      reasons.push(`field_candidates[${index}].field_name missing`);
    }
    if (field.value.length === 0) {
      reasons.push(`field_candidates[${index}].value missing`);
    }
    if (field.evidence.length === 0) {
      reasons.push(`field_candidates[${index}].evidence missing`);
    }
  }

  if (suppliedStatus !== null && suppliedStatus !== "valid") {
    reasons.push(`validation_result.status is ${suppliedStatus}`);
  }

  return Object.freeze({
    status: reasons.length === 0 ? "valid" : "deferred",
    reasons: Object.freeze(reasons)
  });
}

function readFieldCandidates(value: unknown): readonly SchemaGroundedFieldCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Object.freeze(
    value.slice(0, MAX_FIELD_CANDIDATES).flatMap((entry) => {
      const record = readRecord(entry);
      if (record === null) {
        return [];
      }

      const fieldName = readNonEmptyString(record.field_name);
      const rawValue = readNonEmptyString(record.value);
      const evidence = readNonEmptyString(record.evidence);
      if (fieldName === null || rawValue === null || evidence === null) {
        return [];
      }

      return [
        Object.freeze({
          field_name: fieldName,
          value: rawValue.slice(0, MAX_FIELD_VALUE_CHARS),
          evidence: evidence.slice(0, MAX_FIELD_EVIDENCE_CHARS),
          confidence: clampConfidence(readNumber(record.confidence) ?? 0)
        })
      ];
    })
  );
}

function readPrimaryPayloadText(rawPayload: Readonly<Record<string, unknown>>): string | null {
  return (
    readNonEmptyString(rawPayload.matched_text) ??
    readNonEmptyString(rawPayload.excerpt) ??
    readNonEmptyString(rawPayload.observation) ??
    readNonEmptyString(rawPayload.value) ??
    readNonEmptyString(rawPayload.content)
  );
}

function fieldNameForObjectKind(objectKind: string): string {
  switch (objectKind) {
    case "preference":
      return "preference";
    case "decision":
      return "decision";
    case "constraint":
      return "constraint";
    case "procedure":
      return "procedure";
    default:
      return "content";
  }
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}
